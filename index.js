const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const redis = require('redis');
const retry = require('async-retry');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
}));

const server = http.createServer(app);

let rooms = {}; // Store room info including users and messages

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

    // Load existing rooms, users, and messages from Redis
    const roomKeys = await pubClient.keys('room:*:users');
    for (const key of roomKeys) {
      const roomName = key.split(':')[1];
      const users = await pubClient.sMembers(key);
      rooms[roomName] = { users };

      // Load messages for the room
      const storedMessages = await pubClient.lRange(`room:${roomName}:messages`, 0, -1);
      const messages = storedMessages.map((msg) => JSON.parse(msg));
      rooms[roomName].messages = messages;
    }
    console.log('Loaded rooms, users, and messages from Redis:', rooms);
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

const createRoom = async (room, username, socket, fromEvent) => {
  if (!rooms[room]) {
    console.log(`Creating Room ${room} in ${fromEvent} event`);
    socket.join(room);
    socket.username = username;
    socket.rooms.add(room);
    rooms[room] = {
      users: [username],
    };
    await pubClient.sAdd(`room:${room}:users`, username);
    await pubClient.sAdd(`user:${username}:rooms`, room);

    // Emit to all clients that a new room has been created
    io.emit('room_created', { room });

    io.to(room).emit('user_list', rooms[room].users);
    getAllRooms(socket);
    getUserRooms(username, socket);
    console.log(`Room ${room} created by ${username}`);
    return rooms[room];
  }
  return false;
};

const addUserInRoom = async (room, username, socket, fromEvent) => {
  if (rooms[room] && !rooms[room].users.includes(username)) {
    console.log(`User ${username} is not in room ${room}. Adding to room from event ${fromEvent}`);
    rooms[room].users.push(username);
    await pubClient.sAdd(`room:${room}:users`, username);
    await pubClient.sAdd(`user:${username}:rooms`, room);
    socket.join(room);
    socket.rooms.add(room);
    socket.username = username;
    io.to(room).emit('user_list', rooms[room].users);
    getAllRooms(socket);
    getUserRooms(username, socket);
    return rooms[room];
  }
  return false;
};

const getUserRooms = async (username, socket) => {
  try {
    const userRooms = await pubClient.sMembers(`user:${username}:rooms`);
    socket.emit('user_rooms', userRooms);
  } catch (error) {
    console.error('Error getting user rooms:', error);
    socket.emit('error_message', { message: 'Failed to get user rooms.' });
  }
};

/*const getRoomMessages = async (room, socket, page, pageSize) => {
  try {
    let start = 0;
    let end = -1;
    if(page > 0) {
      const totalMessages = await pubClient.lLen(`room:${room}:messages`);
      start = totalMessages - page * pageSize;
      end = start + pageSize - 1;
    }
    const storedMessages = await pubClient.lRange(`room:${room}:messages`, Math.max(0, start), end);
    const messages = storedMessages.map((msg) => JSON.parse(msg));
    return messages;
  } catch (error) {
    console.error('Error getting room messages:', error);
    throw error;
  }
};*/

const getRoomMessages = async (room, page = 1, pageSize = 50, socket) => {
  try {
    const totalMessages = await pubClient.lLen(`room:${room}:messages`);
    
    const end = totalMessages - (page - 1) * pageSize - 1;
    const start = Math.max(0, end - pageSize + 1);

    console.log(`Total Message for room ${room} is ${totalMessages} and returning messages from ${start} to ${end} 
      with parameters Page ${page} and Page Size ${pageSize}`);
    
    if (start > end || end < 0) {
      return [];
    }

    const storedMessages = await pubClient.lRange(`room:${room}:messages`, start, end);
    const allMessagesStr = await pubClient.lRange(`room:${room}:messages`, 0, -1);
    const allMessages = allMessagesStr.map((msg) => JSON.parse(msg));
    console.log(`All messages for room ${room} is ${JSON.stringify(allMessages)}`);
    console.log(`From All Start Message is ${JSON.stringify(allMessages[0])} and end Message is ${JSON.stringify(allMessages[allMessages.length - 1])}`);
    const messages = storedMessages.map((msg) => JSON.parse(msg));
    //const retVal = messages.reverse(); 
    console.log(`Start Message is ${JSON.stringify(messages[0])} and end Message is ${JSON.stringify(messages[messages.length - 1])}`);
    return messages;
  } catch (error) {
    console.error('Error getting room messages:', error);
    throw error;
  }
};



const getAllRooms = async (socket) => {
  try {
    const roomNames = Object.keys(rooms);
    socket.emit('room_list', roomNames);
    return roomNames;
  } catch (error) {
    console.error('Error getting all room list:', error);
    socket.emit('error_message', { message: 'Failed to get all room list.' });
  }
  return null;
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('user_connected', async ({ username }) => {
    socket.username = username;

    await pubClient.set(`user:${username}:socket`, socket.id);

    const userRooms = await pubClient.sMembers(`user:${username}:rooms`);

    // Rejoin the rooms
    for (const room of userRooms) {
      socket.join(room);
      socket.rooms.add(room); // Update socket's rooms set
      socket.username = username;
      console.log(`User ${username} rejoined room ${room}`);
    }
  });

  socket.on('create_room', async ({ room, username }) => {
    try {
      if (!rooms[room]) {
        await createRoom(room, username, socket, 'create_room');
      } else {
        console.log(`Room ${room} already exists with details :`, JSON.stringify(rooms[room]));
        await addUserInRoom(room, username, socket, 'create_room');
      }
      socket.emit('joined_room', { room });
    } catch (error) {
      console.error('Error creating room:', error);
      socket.emit('error_message', { message: 'Failed to create room.' });
    }
  });

  socket.on('join_room', async ({ room, username }) => {
    try {
      if (rooms[room]) {
        await addUserInRoom(room, username, socket, 'join_room');
      } else {
        await createRoom(room, username, socket, 'join_room');
      }
      socket.emit('joined_room', { room });
    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit('error_message', { message: 'Failed to join room.' });
    }
  });

  socket.on('send_message', async (data) => {
    const room = data.room;
    const username = data.author;

    // Implement retry logic for Redis operations
    try {
      if (!rooms[room]) {
        await createRoom(room, username, socket, 'send_message');
      } else {
        await addUserInRoom(room, username, socket, 'send_message');
      }

      // Store the message in Redis with expiration
      const messageData = {
        room,
        author: username,
        message: data.message,
        time: data.time,
      };

      await retry(async () => {
        await pubClient.rPush(`room:${room}:messages`, JSON.stringify(messageData));
        // Set expiration time for messages (e.g., 7 days)
        await pubClient.expire(`room:${room}:messages`, 7 * 24 * 60 * 60);
      }, {
        retries: 5, // Number of retry attempts
        factor: 2, // Exponential backoff factor
        minTimeout: 100, // Minimum wait time between retries in ms
      });

      console.log(`Message from ${username} in room ${room}:`, data.message);
      io.to(room).emit('receive_message', messageData);
    } catch (error) {
      console.error('Error sending message:', error);
      socket.emit('error_message', { message: 'Failed to send message.' });
    }
  });

  socket.on('get_user_rooms', async ({ username }) => {
    getUserRooms(username, socket);
  });

  socket.on('get_room_messages', async ({ room }) => {
    try {
      const messages = await getRoomMessages(room, -1, -1, socket);
      socket.emit('message_history', { room, messages });
    } catch (error) {
      socket.emit('error_message', { message: 'Failed to get room messages.' });
    }
  });

  socket.on('get_room_messages_pages', async ({ room, page = 1, pageSize = 50 }) => {
    try {
      const messages = await getRoomMessages(room, page, pageSize, socket);
      socket.emit('message_history_pages', { room, messages, page, pageSize });
    } catch (error) {
      socket.emit('error_message_pages', { message: 'Failed to get room messages.' });
    }
  });

  socket.on('get_all_rooms', async () => {
    getAllRooms();
  });

  socket.on('disconnect', async () => {
    const username = socket.username;

    if (username) {
      try {
        // Get the rooms the user is part of
        const userRooms = await pubClient.sMembers(`user:${username}:rooms`);

        for (const room of userRooms) {
          await pubClient.sRem(`room:${room}:users`, username);
          if (rooms[room]) {
            rooms[room].users = rooms[room].users.filter((user) => user !== username);
            io.to(room).emit('user_list', rooms[room].users);
            //not deleting the room as the users can rejoin the room and should see the old messages
            /*if (rooms[room].users.length === 0) {
              // Delete the room's messages and users from Redis
              await pubClient.del(`room:${room}:messages`);
              await pubClient.del(`room:${room}:users`);
              delete rooms[room];
              console.log(`Room ${room} has no users. Deleted.`);

              // Emit to all clients that a room has been deleted
              io.emit('room_deleted', { room });
            }*/
          }
        }

        // Remove the user's socket ID and rooms
        //not deleting the room as the users can rejoin the room and should see the old messages
        //await pubClient.del(`user:${username}:socket`);
        //await pubClient.del(`user:${username}:rooms`);
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
