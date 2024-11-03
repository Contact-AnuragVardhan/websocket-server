const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

let rooms = {}; 

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('join_room', ({ room, username }) => {
    socket.join(room);
    socket.username = username;
    socket.room = room;
    if (!rooms[room]) {
        rooms[room] = [];
    }
    rooms[room].push(username);
    io.to(room).emit('user_list', rooms[room]);
    console.log(`User ${socket.id} joined room: ${room}`);
  });

  socket.on('send_message', (data) => {
    io.to(data.room).emit('receive_message', data);
  });

  socket.on('disconnect', () => {
    const { room, username } = socket;
    if (room && username && rooms[room]) {
      rooms[room] = rooms[room].filter((user) => user !== username);
      io.to(room).emit('user_list', rooms[room]);
    }
    console.log(`User disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});
