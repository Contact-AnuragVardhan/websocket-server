// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // or specify your Webview origin if needed
  },
});

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("joinRoom", ({ roomId, username }) => {
    socket.join(roomId);
    console.log(`${username} joined room ${roomId}, socket ID: ${socket.id}`);
    // Notify others
    socket.to(roomId).emit("userJoined", { username, socketId: socket.id });
  });

  socket.on("leaveRoom", ({ roomId, username }) => {
    socket.leave(roomId);
    console.log(`${username} left room ${roomId}`);
    // Notify others
    socket.to(roomId).emit("userLeft", { username, socketId: socket.id });
  });

  // Receive raw PCM from extension or web client
  socket.on("pcmData", (data) => {
    // data should contain { roomId, buffer (or base64), userId }
    console.log(data.buffer);
    socket.to(data.roomId).emit("pcmData", data);
    //socket.emit("pcmData", data);
  });

  // Simple text chat
  socket.on("chatMessage", (data) => {
    // data = { roomId, message, username, userId }
    io.to(data.roomId).emit("chatMessage", data);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

server.listen(3001, () => {
  console.log("Socket.IO server listening on http://localhost:3001");
});
