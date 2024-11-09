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

  const createRoom = async ({ room, username, socket }) => {
    socket.join(room);
    socket.username = username;
    socket.room = room;
    rooms[room] = {
      owner: username,
      ownerSocketId: socket.id,
      users: [username],
      pending: [],
    };
    await pubClient.sAdd(`room:${room}:users`, username);
    io.to(room).emit('user_list', rooms[room].users);
    console.log(`Room ${room} created by ${username}`);
    return rooms[room];
  };

  socket.on('create_room', async ({ room, username }) => {
    try {
      if (!rooms[room]) {
        console.log(`Creating Room ${room} in create_room event`);
        await createRoom({ room, username, socket });
      } else {
        console.log(`Room ${room} already exists with details :`, JSON.stringify(rooms[room]));
        socket.emit('error_message', { message: 'Room already exists.' });
      }
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
      console.log(`Room ${room} does not exist.`);
      socket.emit('room_info', { roomId: room, message: 'Room doesnot exist', roomNotExists: true });
    }
  });

  /*socket.on('get_room_info', async ({ room, username }) => {
    console.log(`User connected from get_room_info : ${socket.id}`);
    console.log("*************************", JSON.stringify(rooms));
    updateUserSocketId(username, socket.id);
    if (rooms[room]) {
      const info = rooms[room];
      socket.emit('room_info', { roomId: room, owner: info.owner, users: info.users });
    }
    else {
      console.log(`Room ${room} does not exist. Creating new room from get_room_info event for ${username}.`);
      try {
        const newRoomInfo = await createRoom({ room, username, socket });
        console.log("*************************", JSON.stringify(rooms), "New Room Info:", JSON.stringify(newRoomInfo));
        socket.emit('room_info', { roomId: room, owner: username, users: (rooms[room] || newRoomInfo).users });
      } catch (error) {
        console.error('Error creating room in get_room_info:', error);
        socket.emit('error_message', { message: 'Failed to create room.' });
      }
      //socket.emit('room_info', { roomId: room, message: 'Room doesnot exist' });
    }
  });*/

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

  const approveUser = async ({ room, approvedUsername, currentUsername }) => {
    try {
      if (rooms[room] && (rooms[room].owner === socket.username || rooms[room].owner === currentUsername)) {
        const pendingUser = rooms[room].pending.find(user => user.username === approvedUsername);
        if (pendingUser) {
          rooms[room].users.push(approvedUsername);
          rooms[room].pending = rooms[room].pending.filter(user => user.username !== approvedUsername);
          await pubClient.sAdd(`room:${room}:users`, approvedUsername);
          io.to(room).emit('user_list', rooms[room].users);
          console.log('user_list', rooms[room].users);
          // Notify the approved user
          io.to(pendingUser.socketId).emit('join_approved', { room, approvedUsername });
          // Update pending requests for the owner
          const pendingUsernames = rooms[room].pending.map(user => user.username);
          io.to(rooms[room].ownerSocketId).emit('pending_requests', pendingUsernames);
        }
      }
    } catch (error) {
      console.error('Error approving user:', error);
    }
  };

  socket.on('approve_user', async ({ room, approvedUsername, currentUsername }) => {
    approveUser({ room, approvedUsername, currentUsername });
  });

  socket.on('deny_user', async ({ room, deniedUsername, currentUsername }) => {
    try {
      if (rooms[room] && (rooms[room].owner === socket.username || rooms[room].owner === currentUsername)) {
        const pendingUser = rooms[room].pending.find(user => user.username === deniedUsername);
        if (pendingUser) {
          rooms[room].pending = rooms[room].pending.filter(user => user.username !== deniedUsername);
          // Notify the denied user
          io.to(pendingUser.socketId).emit('join_denied', { room, deniedUsername });
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
    console.log("****************send_message data.room", data.room, JSON.stringify(data));
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
          // If there are still users in the room, assign a new owner
          if (rooms[room].users.length > 0) {
            const newOwner = rooms[room].users[0]; // Select the first user as the new owner
            rooms[room].owner = newOwner;
            io.to(room).emit('new_owner', { newOwner, oldOwner: username, roomId: room });
            console.log(`New owner of room ${room} is ${newOwner}`);
          } else {
            delete rooms[room];
            console.log(`Closing Room ${room} as no user is in the room.`)
            //io.to(room).emit('room_closed', { message: 'Room owner has left. Room is closed.' });
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
        const newSocket = io.sockets.sockets.get(newSocketId);
        if(newSocket) {
          newSocket.join(room); // Make the new socket ID join the room
          newSocket.username = username;
        }
       
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

  /*const updateUserSocketId = (username, newSocketId) => {
    // Find the old socket ID associated with the username, if it exists
    let oldSocketId = null;
    let alreadyExists = false;

    Object.keys(rooms).forEach((room) => {
      const roomInfo = rooms[room];

      // If the user is the owner, update the owner's socket ID
      if (roomInfo.owner === username && roomInfo.ownerSocketId !== newSocketId) {
        oldSocketId = roomInfo.ownerSocketId;
        roomInfo.ownerSocketId = newSocketId;
        alreadyExists = true;
      }

      // Update pending users list
      roomInfo.pending = roomInfo.pending.map((pendingUser) => {
        if (pendingUser.username === username && pendingUser.socketId !== newSocketId) {
          oldSocketId = oldSocketId || pendingUser.socketId; // Track old socket ID if not already set
          alreadyExists = true;
          return { ...pendingUser, socketId: newSocketId };
        }
        return pendingUser;
      });

      // Check if the user is in the room's user list
      if (roomInfo.users.includes(username) && oldSocketId && oldSocketId !== newSocketId) {
        const newSocket = io.sockets.sockets.get(newSocketId);
        newSocket?.join(room); // Make the new socket ID join the room
        newSocket?.username = username;
      }
    });

    console.log(`Old socket ID ${oldSocketId} with new socket ID ${newSocketId} for user: ${username}`);
    // If an old socket ID was found, disconnect it
    if (oldSocketId && oldSocketId !== newSocketId && alreadyExists) {
      const oldSocket = io.sockets.sockets.get(oldSocketId);
      if (oldSocket) {
        oldSocket.disconnect(true);
        console.log(`Disconnected old socket ID ${oldSocketId} with new socket ID ${newSocketId} for user: ${username}`);
      }
    }

    console.log(`Updated socket ID for user: ${username} to ${newSocketId}`);
  };*/

});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});