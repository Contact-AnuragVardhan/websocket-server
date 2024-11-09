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

let rooms = {}; // Store room info including users

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
      users: [username],
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

  socket.on('send_message', async (data) => {
    const room = data.room;
    const username = data.author;

    if (!rooms[room]) {
      console.log(`Creating Room ${room} in send_message event`);
      await createRoom({ room, username, socket });
    } else {
      if (!rooms[room].users.includes(username)) {
        console.log(`User ${username} is not in room ${room}. Adding to room.`);
        rooms[room].users.push(username);
        await pubClient.sAdd(`room:${room}:users`, username);
        socket.join(room);
        socket.username = username;
        socket.room = room;
        io.to(room).emit('user_list', rooms[room].users);
      }
    }

    console.log(`Message from ${username} in room ${room}:`, data.message);
    io.to(room).emit('receive_message', data);
  });

  socket.on('disconnect', async () => {
    const { room, username } = socket;
    if (room && username) {
      try {
        await pubClient.sRem(`room:${room}:users`, username);
        if (rooms[room]) {
          rooms[room].users = rooms[room].users.filter((user) => user !== username);
          io.to(room).emit('user_list', rooms[room].users);
          if (rooms[room].users.length === 0) {
            delete rooms[room];
            console.log(`Room ${room} has no users. Deleted.`);
          }
        }
      } catch (error) {
        console.error('Error during disconnect:', error);
      }
    }
    console.log(`User disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});