const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const redis = require('redis');

const app = express();
app.use(cors());

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
}));

const server = http.createServer(app);

const pubClient = redis.createClient({
  url: process.env.REDIS_URL,
});
const subClient = pubClient.duplicate();

pubClient.on('error', (err) => console.error('Redis Pub Client Error', err));
subClient.on('error', (err) => console.error('Redis Sub Client Error', err));


(async () => {
  await pubClient.connect();
  await subClient.connect();
  console.log('Connected to Redis');
})();


const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

io.adapter(createAdapter(pubClient, subClient));

let rooms = {}; 

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('join_room',async ({ room, username }) => {
    try {
          socket.join(room);
    socket.username = username;
    socket.room = room;
    /*if (!rooms[room]) {
        rooms[room] = [];
    }
    rooms[room].push(username);*/
    await pubClient.sAdd(`room:${room}:users`, username);
    //io.to(room).emit('user_list', rooms[room]);
    io.to(room).emit('user_list', usersInRoom);
    //console.log(`User ${socket.id} joined room: ${room}`);
    console.log(`User ${socket.id} (${username}) joined room: ${room}`);
  } catch (error) {
    console.error('Error joining room:', error);
    socket.emit('error_message', { message: 'Failed to join room.' });
  }
  });

  socket.on('send_message', (data) => {
    io.to(data.room).emit('receive_message', data);
  });

  /*socket.on('disconnect', () => {
    const { room, username } = socket;
    if (room && username && rooms[room]) {
      rooms[room] = rooms[room].filter((user) => user !== username);
      io.to(room).emit('user_list', rooms[room]);
    }
    console.log(`User disconnected: ${socket.id}`);
  });*/
  socket.on('disconnect', async () => {
    const { room, username } = socket;
    if (room && username) {
      try {
        await pubClient.sRem(`room:${room}:users`, username);

        const usersInRoom = await pubClient.sMembers(`room:${room}:users`);

        io.to(room).emit('user_list', usersInRoom);
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
