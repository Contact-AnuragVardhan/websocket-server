// server.js
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const redis = require('redis');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
}));

const server = http.createServer(app);

let rooms = {}; // Store room info including owner and pending users

const pubClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
});
const subClient = pubClient.duplicate();

pubClient.on('error', (err) => console.error('Redis Pub Client Error', err));
subClient.on('error', (err) => console.error('Redis Sub Client Error', err));

(async () => {
  try {
    await pubClient.connect();
    await subClient.connect();
    console.log('Connected to Redis');
  } catch (error) {
    console.error('Error connecting to Redis:', error);
  }
})();

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

io.adapter(createAdapter(pubClient, subClient));

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('create_room', async ({ room, username }) => {
    try {
      socket.join(room);
      socket.username = username;
      socket.room = room;
      rooms[room] = {
        owner: username,
        ownerSocketId: socket.id, // Store owner's socket ID
        users: [username],
        pending: [],
      };
      await pubClient.sAdd(`room:${room}:users`, username);
      io.to(room).emit('user_list', rooms[room].users);
      console.log(`Room ${room} created by ${username}`);
    } catch (error) {
      console.error('Error creating room:', error);
      socket.emit('error_message', { message: 'Failed to create room.' });
    }
  });

  socket.on('get_room_info', async ({ room, username }) => {
    console.log(`User connected from get_room_info : ${socket.id}`);
    updateUserSocketId(username, socket.id);
    if (rooms[room]) {
      const info = rooms[room];
      socket.emit('room_info', { roomId: room, owner: info.owner, users: info.users });
    }
    else {
      socket.emit('room_info', { roomId: room, message: 'Room doesnot exist' });
    }
  });

  socket.on('request_join_room', async ({ room, username }) => {
    console.log("In request_join_room with room " + room + " and username " + username);
    try {
      if (rooms[room]) {
        // Store pending user's socket ID
        rooms[room].pending.push({ username, socketId: socket.id });
        // Notify room owner of the join request
        io.to(rooms[room].ownerSocketId).emit('join_request', { username });
        // Emit pending requests to the owner
        const pendingUsernames = rooms[room].pending.map(user => user.username);
        io.to(rooms[room].ownerSocketId).emit('pending_requests', pendingUsernames);
      } else {
        console.error(room + 'Room does not exist.');
        socket.emit('error_message', { message: 'Room does not exist.' });
      }
    } catch (error) {
      console.error('Error requesting to join room:', error);
      socket.emit('error_message', { message: 'Failed to request to join room.' });
    }
  });

  const approveUser = async ({ room, username }) => {
    try {
      if (rooms[room] && rooms[room].owner === socket.username) {
        const pendingUser = rooms[room].pending.find(user => user.username === username);
        if (pendingUser) {
          rooms[room].users.push(username);
          rooms[room].pending = rooms[room].pending.filter(user => user.username !== username);
          await pubClient.sAdd(`room:${room}:users`, username);
          io.to(room).emit('user_list', rooms[room].users);
          console.log('user_list', rooms[room].users);
          // Notify the approved user
          io.to(pendingUser.socketId).emit('join_approved', { room, username });
          // Update pending requests for the owner
          const pendingUsernames = rooms[room].pending.map(user => user.username);
          io.to(rooms[room].ownerSocketId).emit('pending_requests', pendingUsernames);
        }
      }
    } catch (error) {
      console.error('Error approving user:', error);
    }
  };

  socket.on('approve_user', async ({ room, username }) => {
    approveUser({ room, username });
  });

  socket.on('deny_user', async ({ room, username }) => {
    try {
      if (rooms[room] && rooms[room].owner === socket.username) {
        const pendingUser = rooms[room].pending.find(user => user.username === username);
        if (pendingUser) {
          rooms[room].pending = rooms[room].pending.filter(user => user.username !== username);
          // Notify the denied user
          io.to(pendingUser.socketId).emit('join_denied', { room, username });
          // Update pending requests for the owner
          const pendingUsernames = rooms[room].pending.map(user => user.username);
          io.to(rooms[room].ownerSocketId).emit('pending_requests', pendingUsernames);
        }
      }
    } catch (error) {
      console.error('Error denying user:', error);
    }
  });

  socket.on('join_room', async ({ room, username }) => {
    console.log("In join_room");
    try {
      if (rooms[room] && rooms[room].users.includes(username)) {
        socket.join(room);
        socket.username = username;
        socket.room = room;
        io.to(room).emit('user_list', rooms[room].users);
        console.log(`User ${socket.id} (${username}) joined room: ${room}`);
      } else {
        console.error('You are not approved to join this room.');
        socket.emit('error_message', { message: 'You are not approved to join this room.' });
      }
    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit('error_message', { message: 'Failed to join room.' });
    }
  });

  socket.on('send_message', (data) => {
    console.log("****************send_message data.room", data.room);
    io.to(data.room).emit('receive_message', data);
  });

  socket.on('disconnect', async () => {
    const { room, username } = socket;
    if (room && username) {
      try {
        await pubClient.sRem(`room:${room}:users`, username);
        if (rooms[room]) {
          rooms[room].users = rooms[room].users.filter((user) => user !== username);
          io.to(room).emit('user_list', rooms[room].users);

          // If the disconnecting user is the owner, handle room closure or ownership transfer
          if (rooms[room].owner === username) {
            // Optionally, handle room closure or assign a new owner
            delete rooms[room];
            io.to(room).emit('room_closed', { message: 'Room owner has left. Room is closed.' });
          }
        }
      } catch (error) {
        console.error('Error during disconnect:', error);
      }
    }
    console.log(`User disconnected: ${socket.id}`);
  });

  const updateUserSocketId = (username, newSocketId) => {
    // Find the old socket ID associated with the username, if it exists
    let oldSocketId = null;
  
    Object.keys(rooms).forEach((room) => {
      const roomInfo = rooms[room];
  
      // If the user is the owner, update the owner's socket ID
      if (roomInfo.owner === username) {
        oldSocketId = roomInfo.ownerSocketId;
        roomInfo.ownerSocketId = newSocketId;
      }
  
      // Update pending users list
      roomInfo.pending = roomInfo.pending.map((pendingUser) => {
        if (pendingUser.username === username) {
          oldSocketId = oldSocketId || pendingUser.socketId; // Track old socket ID if not already set
          return { ...pendingUser, socketId: newSocketId };
        }
        return pendingUser;
      });
  
      // Check if the user is in the room's user list
      if (roomInfo.users.includes(username)) {
        io.sockets.sockets.get(newSocketId)?.join(room); // Make the new socket ID join the room
      }
    });
  
    // If an old socket ID was found, disconnect it
    if (oldSocketId && oldSocketId !== newSocketId) {
      const oldSocket = io.sockets.sockets.get(oldSocketId);
      if (oldSocket) {
        oldSocket.disconnect(true);
        console.log(`Disconnected old socket ID ${oldSocket} with new socket ID ${newSocketId} for user: ${username}`);
      }
    }
  
    console.log(`Updated socket ID for user: ${username} to ${newSocketId}`);
  };  

});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});