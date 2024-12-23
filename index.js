// index.js
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const redis = require('redis');
const retry = require('async-retry');
const axios = require('axios');
const cheerio = require('cheerio');

const logger = require('./logger');

const app = express();

app.use(express.json());

app.use(
    cors({
        origin: '*',
        methods: ['GET', 'POST'],
    })
);

const server = http.createServer(app);

const pubClient = redis.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
    //url: 'rediss://red-ct2idc5svqrc738bfef0:M9oWgWDMRXA3ds4n1GReuNlUuo3Pmwjy@oregon-redis.render.com:6379',
});
const subClient = pubClient.duplicate();

pubClient.on('error', (err) => logger.error('Redis Pub Client Error', err));
subClient.on('error', (err) => logger.error('Redis Sub Client Error', err));

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
    maxHttpBufferSize: 1e8, // 100 MB limit
});

//const isMobileDebug = false;


(async () => {
    try {
        await pubClient.connect();
        await subClient.connect();
        logger.info('Connected to Redis');

        io.adapter(createAdapter(pubClient, subClient));

        const PORT = process.env.PORT || 3001;
        const isMobileDebug = true;
        if (isMobileDebug) {
            server.listen(PORT, '0.0.0.0', () => {
                logger.info(`WebSocket server running on port ${PORT}`);
            });
        } else {
            server.listen(PORT, () => {
                logger.info(`WebSocket server running on port ${PORT}`);
            });
        }

        io.on('connection', (socket) => {
            logger.info(`User connected: ${socket.id}`);

            socket.on('user_connected', async ({ username }) => {
                validateUser(username, 'user_connected');
                handleSocketInitialization(socket, username);

                await pubClient.sAdd(`user:${username}:sockets`, socket.id);
                logger.info(`New socketId is ${socket.id} for username ${username}`);

                // Rejoin all rooms the user was part of
                const userRooms = await pubClient.sMembers(`user:${username}:rooms`);
                for (const room of userRooms) {
                    handleSocketInitialization(socket, username, room);
                    logger.info(`User ${username} rejoined room ${room}`);
                }
            });

            socket.on('create_room', async ({ room, username, initialMessages }) => {
                try {
                    validateUser(username, 'create_room');
                    const roomExists = await pubClient.exists(`room:${room}:users`);
                    if (!roomExists) {
                        await createRoom(room, username, initialMessages, socket, 'create_room');
                    } else {
                        logger.info(`Room ${room} already exists`);
                        await addUserInRoom(room, username, socket, 'create_room');
                    }
                    socket.emit('joined_room', { room });
                } catch (error) {
                    logger.error('Error creating room:', error);
                    socket.emit('error_message', { message: 'Failed to create room.', error });
                }
            });

            socket.on('join_room', async ({ room, username }) => {
                try {
                    validateUser(username, 'join_room');
                    const roomExists = await pubClient.exists(`room:${room}:users`);
                    if (roomExists) {
                        await addUserInRoom(room, username, socket, 'join_room');
                    } else {
                        await createRoom(room, username, null, socket, 'join_room');
                    }
                    socket.emit('joined_room', { room });
                } catch (error) {
                    logger.error('Error joining room:', error);
                    socket.emit('error_message', { message: 'Failed to join room.', error });
                }
            });

            socket.on('send_message', (data) => {
                const room = data.room;
                const username = data.author;

                validateUser(username, 'send_message');
                handleSocketInitialization(socket, username, room);

                pubClient.exists(`room:${room}:users`)
                    .then((roomExists) => {
                        if (!roomExists) {
                            return createRoom(room, username, null, socket, 'send_message');
                        } else {
                            return addUserInRoom(room, username, socket, 'send_message');
                        }
                    })
                    .then(() => {
                        addMessage(data, 'user');
                    })
                    .catch((error) => {
                        logger.error('Error sending message:', error);
                        socket.emit('error_message', { message: 'Failed to send message.', error });
                    });
            });

            socket.on('get_user_rooms', ({ username }) => {
                validateUser(username, 'get_user_rooms');
                handleSocketInitialization(socket, username);
                getUserRooms(username, socket);
            });

            socket.on('get_user_in_rooms', ({ room }) => {
                getAllUserInRooms(room, socket);
            });

            socket.on('get_room_messages', ({ room, username }) => {
                validateUser(username, 'get_room_messages');
                getRoomMessages(room, -1, -1, socket, username)
                    .then(({ messages, totalMessages }) => {
                        socket.emit('message_history', { room, messages, totalMessages });
                    })
                    .catch((error) => {
                        socket.emit('error_message', { message: 'Failed to get room messages.', error });
                    });
            });

            socket.on('get_room_messages_pages', ({ room, page = 1, pageSize = 50, username }) => {
                validateUser(username, 'get_room_messages_pages');
                getRoomMessages(room, page, pageSize, socket, username)
                    .then(({ messages, totalMessages }) => {
                        socket.emit('message_history_pages', { room, messages, page, pageSize, totalMessages });
                    })
                    .catch((error) => {
                        socket.emit('error_message', { message: 'Failed to get room messages.', error });
                    });
            });

            socket.on('get_all_rooms', () => {
                getAllRooms(socket);
            });

            socket.on('update_last_read_message', ({ room, username }) => {
                validateUser(username, 'update_last_read_message');
                logger.info(`Updating Last Read Message for Room ${room} for User ${username}`);
                handleSocketInitialization(socket, username);

                const uname = socket.username || username;
                pubClient.set(`user:${uname}:room:${room}:lastReadTime`, (new Date()).getTime());
                //keeping it for later like "watermark" or "read receipts" functionality
                pubClient.lLen(`room:${room}:messages`)
                    .then((totalMessages) => {
                        return pubClient.lIndex(`room:${room}:messages`, totalMessages - 1)
                            .then((latestMessageData) => {
                                const latestMessage = JSON.parse(latestMessageData);
                                if (latestMessage) {
                                    return pubClient.set(`user:${uname}:room:${room}:lastReadMessage`, JSON.stringify(latestMessage));
                                }
                            });
                    })
                    .catch((error) => {
                        logger.error('Error updating last read message:', error);
                    });
            });

            // ---------------------
            // Audio call functionality
            // ---------------------

            socket.on('audio-create-room', async (roomId) => {
                await audioCreateRoom(roomId, socket);
            });

            socket.on('audio-join-room', async (roomId) => {
                await audioJoinRoom(roomId, socket);
            });

            socket.on('offer', (offer, roomId, targetId) => {
                socket.to(targetId).emit('audio-offer', offer, socket.id);
            });

            socket.on('answer', (answer, roomId, targetId) => {
                socket.to(targetId).emit('audio-answer', answer, socket.id);
            });

            socket.on('ice-candidate', (candidate, roomId, targetId) => {
                socket.to(targetId).emit('audio-ice-candidate', candidate, socket.id);
            });

            socket.on('leave-room', async (roomId) => {
                await audioLeaveRoom(roomId, socket);
            });

            socket.on('leave-all-audio-rooms', async () => {
                await audioLeaveAllRooms(socket);
            });

            socket.on('disconnect', async () => {
                const username = socket.username;

                if (username) {
                    logger.info(`SocketId ${socket.id} is getting deleted for username ${username}`);
                    pubClient.sRem(`user:${username}:sockets`, socket.id)
                        .catch((error) => {
                            logger.error('Error during disconnect:', error);
                        });
                    logger.info(`User disconnected: ${socket.id}`);
                } else {
                    logger.info(`In disconnect Socket username not set for socket ID ${socket.id}`);
                }

                // Handle call user disconnection
                await audioLeaveAllRooms(socket);
            });
        });

    } catch (error) {
        logger.error('Error connecting to Redis:', error);
    }
})();

const createRoom = async (room, username, initialMessages, socket, fromEvent) => {
    handleSocketInitialization(socket, username, room);
    const roomExists = await pubClient.exists(`room:${room}:users`);
    if (!roomExists) {
        logger.info(`Creating Room ${room} in ${fromEvent} event`);
        await pubClient.sAdd(`room:${room}:users`, username);
        await pubClient.sAdd(`user:${username}:rooms`, room);
        await pubClient.sAdd('rooms:set', room);

        // Emit to all clients that a new room has been created
        io.emit('room_created', { room });
        const roomName = getRoomNameFromId(room);
        const message = username ? `${roomName} created by ${username}` : `${roomName} created`;
        addDefaultMessage(room, username, message);

        //add initial messages to the room
        if (initialMessages && initialMessages.length > 0) {
            for (const msg of initialMessages) {
                addMessage(msg, 'user');
            }
        }

        const users = await pubClient.sMembers(`room:${room}:users`);
        io.to(room).emit('user_list', { room, users });
        getAllRooms(socket);
        getUserRooms(username, socket);
        logger.info(`Room ${room} created by ${username}`);
        return true;
    }
    return false;
};

const addUserInRoom = async (room, username, socket, fromEvent) => {
    handleSocketInitialization(socket, username, room);

    const userInRoom = await pubClient.sIsMember(`room:${room}:users`, username);
    if (!userInRoom) {
        logger.info(`User ${username} is not in room ${room}. Adding to room from event ${fromEvent}`);
        await pubClient.sAdd(`room:${room}:users`, username);
        await pubClient.sAdd(`user:${username}:rooms`, room);
        const roomName = getRoomNameFromId(room);
        addDefaultMessage(room, username, `${username} joined the ${roomName}`);

        const users = await pubClient.sMembers(`room:${room}:users`);
        io.to(room).emit('user_list', { room, users });
        getAllRooms(socket);
        getUserRooms(username, socket);
        return true;
    }
    return false;
};

const getAllUserInRooms = async (room, socket) => {
    try {
        const users = await pubClient.sMembers(`room:${room}:users`);
        socket.emit('users_in_room', { room, users });
    } catch (error) {
        logger.error(`Error getting users in room ${room}:`, error);
        socket.emit('error_message', { message: `Failed to get users in room ${room}`, error });
    }
};

const getUserRooms = async (username, socket) => {
    try {
        const rooms = await pubClient.sMembers(`user:${username}:rooms`);
        const userRooms = await Promise.all(
            rooms.map(async (room) => {
                try {
                    const latestMessage = await getMessageNotificationForRoom(username, room);
                    return { room, latestMessage };
                }
                catch (error) {
                    return { room, latestMessage: null };
                }
            })
        );
        socket.emit('user_rooms', userRooms);
        /*const userRooms = [];
        if (rooms.length > 0) {
            for (const room of rooms) {
                const latestMessage = await getMessageNotificationForRoom(username, room);
                userRooms.push({ room, latestMessage });
            }
        }
        socket.emit('user_rooms', userRooms);*/
    } catch (error) {
        logger.error('Error getting user rooms:', error);
        socket.emit('error_message', { message: 'Failed to get user rooms.', error });
    }
};

const getRoomMessages = async (room, page = 1, pageSize = 50, socket, username) => {
    const startTime = Date.now();
    try {
        handleSocketInitialization(socket, username);

        const initTime = Date.now();
        logger.info(`Time taken for handleSocketInitialization: ${initTime - startTime}ms`);

        const totalMessages = await pubClient.lLen(`room:${room}:messages`);
        const lenTime = Date.now();
        logger.info(`Time taken for fetching totalMessages: ${lenTime - initTime}ms`);

        const end = totalMessages - (page - 1) * pageSize - 1;
        const start = Math.max(0, end - pageSize + 1);

        logger.info(
            `Total Message for room ${room} is ${totalMessages} and returning messages from ${start} to ${end} 
      with parameters Page ${page} and Page Size ${pageSize}`
        );

        if (start > end || end < 0) {
            const earlyExitTime = Date.now();
            logger.info(`Early exit due to invalid range. Total time taken: ${earlyExitTime - startTime}ms`);
            return [];
        }

        const storedMessages = await pubClient.lRange(`room:${room}:messages`, start, end);
        const fetchMessagesTime = Date.now();
        logger.info(`Time taken for fetching messages: ${fetchMessagesTime - lenTime}ms`);
        const uname = socket.username || username;
        pubClient.set(`user:${uname}:room:${room}:lastReadTime`, (new Date()).getTime());
        const messages = storedMessages.map((msg) => JSON.parse(msg));
        if (messages && messages.length > 0 && messages[messages.length - 1]) {
            const lastMessage = messages[messages.length - 1];
            await pubClient.set(`user:${uname}:room:${room}:lastReadMessage`, JSON.stringify(lastMessage));
        }
        const finalProcessTime = Date.now();
        logger.info(`Time taken for processing and updating last read message: ${finalProcessTime - fetchMessagesTime}ms`);
        logger.info(
            `Start Message is ${JSON.stringify(messages[0])} and end Message is ${JSON.stringify(
                messages[messages.length - 1]
            )}`
        );
        return { messages, totalMessages };
    } catch (error) {
        logger.error('Error getting room messages:', error);
        throw error;
    }
};

const getAllRooms = async (socket) => {
    try {
        const roomNames = await pubClient.sMembers('rooms:set');
        socket.emit('room_list', roomNames);
        return roomNames;
    } catch (error) {
        logger.error('Error getting all room list:', error);
        socket.emit('error_message', { message: 'Failed to get all room list.', error });
    }
    return null;
};

const addMessage = async (data, messageType) => {
    if (data) {
        try {
            const room = data.room;
            const username = data.author;
            // Store the message in Redis with expiration
            const messageData = {
                ...data,
                author: data.author || username,
                messageType: data.messageType || messageType,
            };

            await retry(
                async () => {
                    await pubClient.rPush(`room:${room}:messages`, JSON.stringify(messageData));
                    // Set expiration time for messages (e.g., 7 days)
                    await pubClient.expire(`room:${room}:messages`, 7 * 24 * 60 * 60);
                },
                {
                    retries: 5, // Number of retry attempts
                    factor: 2, // Exponential backoff factor
                    minTimeout: 100, // Minimum wait time between retries in ms
                }
            );

            logger.info(`Message from ${username} in room ${room}:`, data.message);
            logger.info(`added message ${JSON.stringify(messageData)}`);
            io.to(room).emit('receive_message', messageData);

            if (messageType !== 'system') {
                // Notifying all users who are part of the room, even if they're not connected to the room
                const usersInRoom = await pubClient.sMembers(`room:${room}:users`);
                for (const user of usersInRoom) {
                    const userSocketIds = await pubClient.sMembers(`user:${user}:sockets`);
                    logger.info(`userSocketIds for ${user} are ${userSocketIds}`);
                    if (userSocketIds && userSocketIds.length > 0) {
                        for (const userSocketId of userSocketIds) {
                            if (messageData.author !== user) {
                                io.to(userSocketId).emit('new_message_notification', { room, message: messageData });
                            } else {
                                logger.info(`${messageData} not sent to ${user} as ${user} is the Author.`);
                            }
                        }
                    }
                }
            }
        } catch (error) {
            logger.error('Error sending message:', error);
            throw error;
        }
    }
};

const addDefaultMessage = (room, username, message) => {
    const date = new Date();
    const objMessage = {
        id: date.getTime(),
        room,
        author: 'Blackbox',
        message,
        affectedUser: username,
        time: date.toISOString(),
    };
    addMessage(objMessage, 'system');
};

const getMessageNotificationForRoom = async (username, room) => {
    let lastReadTimeString = await pubClient.get(`user:${username}:room:${room}:lastReadTime`);
    const totalMessages = await pubClient.lLen(`room:${room}:messages`);
    const latestMessageData = await pubClient.lIndex(`room:${room}:messages`, totalMessages - 1);
    if (latestMessageData && lastReadTimeString) {
        const latestMessage = JSON.parse(latestMessageData);
        if (typeof lastReadTimeString === 'string') {
            lastReadTimeString = Number(lastReadTimeString);
        }
        if (lastReadTimeString && isValidDate(lastReadTimeString) && latestMessage) {
            const latestMessageTime = new Date(latestMessage.time);
            const lastReadTime = new Date(lastReadTimeString);
            if (latestMessageTime > lastReadTime) {
                return latestMessage;
            }
        }
    }
    return null;
};

const audioCreateRoom = async (roomId, socket) => {
    const hostId = await pubClient.get(`callRoom:${roomId}:host`);
    if (!hostId) {
        await pubClient.set(`callRoom:${roomId}:host`, socket.id);
        await pubClient.sAdd(`callRoom:${roomId}:participants`, socket.id);
        socket.join(roomId);

        // Get current participants (only host at this time)
        const participants = await pubClient.sMembers(`callRoom:${roomId}:participants`);
        // Send participants (excluding the current user)
        socket.emit('audio-participants', participants.filter(p => p !== socket.id));

        socket.emit('audio-room-created', roomId);
        handleNotificationToAllUserInRoom(roomId, 'audio-call-notification', {
            roomId: roomId,
            socketId: socket.id
        });
        await pubClient.sAdd(`socket:${socket.id}:callRooms`, roomId);
    } else {
        // If room already exists, treat this as a join
        await audioJoinRoom(roomId, socket);
    }
};

const audioJoinRoom = async (roomId, socket) => {
    const hostId = await pubClient.get(`callRoom:${roomId}:host`);
    if (hostId) {
        await pubClient.sAdd(`callRoom:${roomId}:participants`, socket.id);
        socket.join(roomId);

        // Get all current participants
        const participants = await pubClient.sMembers(`callRoom:${roomId}:participants`);
        // Send participant list to the newly joined user (excluding themselves)
        socket.emit('audio-participants', participants.filter(p => p !== socket.id));

        socket.emit('audio-room-joined', roomId);
        socket.to(roomId).emit('audio-user-joined', socket.id);

        handleNotificationToAllUserInRoom(roomId, 'audio-call-notification', {
            roomId: roomId,
            socketId: socket.id
        });

        await pubClient.sAdd(`socket:${socket.id}:callRooms`, roomId);
    } else {
        socket.emit('error', 'Room not found');
    }
};

const audioLeaveRoom = async (roomId, socket) => {
    try {
        if (roomId) {
            await pubClient.sRem(`callRoom:${roomId}:participants`, socket.id);

            const size = await pubClient.sCard(`callRoom:${roomId}:participants`);

            io.to(roomId).emit('audio-user-left', socket.id);

            if (size === 0) {
                await pubClient.del(`callRoom:${roomId}:host`);
                await pubClient.del(`callRoom:${roomId}:participants`);
                handleNotificationToAllUserInRoom(roomId, 'audio-call-disconnected', {
                    roomId: roomId,
                    socketId: socket.id
                });
            }

            await pubClient.sRem(`socket:${socket.id}:callRooms`, roomId);

            socket.leave(roomId);

            // Optionally, send a confirmation to the client
            socket.emit('audio-left-room', roomId);

            console.log(`Socket ${socket.id} left room ${roomId}`);
        }

    } catch (error) {
        console.error(`Error leaving room ${roomId}:`, error);
        socket.emit('error', { message: `Failed to leave room ${roomId}`, error });
    }
};

const audioLeaveAllRooms = async (socket) => {
    const userCallRooms = await pubClient.sMembers(`socket:${socket.id}:callRooms`);
    for (const callRoomId of userCallRooms) {
        await pubClient.sRem(`callRoom:${callRoomId}:participants`, socket.id);
        const size = await pubClient.sCard(`callRoom:${callRoomId}:participants`);
        io.to(callRoomId).emit('audio-user-left', socket.id);
        if (size === 0) {
            // clean up the empty room
            await pubClient.del(`callRoom:${callRoomId}:host`);
            await pubClient.del(`callRoom:${callRoomId}:participants`);
            handleNotificationToAllUserInRoom(callRoomId, 'audio-call-disconnected', {
                roomId: callRoomId,
                socketId: socket.id
            });
        }
    }
    await pubClient.del(`socket:${socket.id}:callRooms`);
};

const handleNotificationToAllUserInRoom = (roomId, notificationType, notificationParams) => {
    pubClient.sMembers(`room:${roomId}:users`)
        .then(usersInRoom => {
            const userPromises = usersInRoom.map(user => {
                return pubClient.sMembers(`user:${user}:sockets`)
                    .then(userSocketIds => {
                        if (userSocketIds && userSocketIds.length > 0) {
                            userSocketIds.forEach(userSocketId => {
                                io.to(userSocketId).emit(notificationType, { ...notificationParams, user: user });
                            });
                        }
                    });
            });
            return Promise.all(userPromises);
        })
        .catch(err => {
            console.error("Error handling notifications:", err);
        });
};

const handleSocketInitialization = (socket, username, room) => {
    if (socket) {
        if (room) {
            // Since socket.join(room) is idempotent we can always use socket.join(room) without checking it
            socket.join(room);
        }
        if (username) {
            socket.username = username;
        }
    }
};

const getRoomNameFromId = (roomId) => {
    const delimiter = '-';
    if (roomId.includes(delimiter)) {
        const parts = roomId.split(delimiter);
        return parts.slice(0, -1).join(delimiter);
    }
    return roomId;
};

const isValidDate = (dateString) => {
    const date = new Date(dateString);
    const retVal = !isNaN(date.getTime());
    return retVal;
};

const validateUser = (username, method) => {
    if (!username) {
        logger.error(`******** Username is empty. We might have issue with websocket in method ${method} ********`);
    }
};

/*************************other route section *****************************************/

const extractMetadata = async (url, messageId) => {
    logger.info(`Info is being extracted from ${url} for messageId ${messageId}`);
    const cacheKey = `metadata:${messageId}-${url}`;
    const cachedData = await pubClient.get(cacheKey);
    if (cachedData) {
        logger.info(`Cache hit for ${url}`);
        return JSON.parse(cachedData);
    }

    logger.info(`Cache miss for ${url}. Fetching metadata...`);
    const response = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        },
        timeout: 5000
    });

    const $ = cheerio.load(response.data);

    // Initialize metadata object
    const metadata = {
        url: url,
        title: '',
        description: '',
        image: '',
        favicon: ''
    };

    //console.log('1',$('meta[property="og:title"]').attr('content'));
    //console.log('2',$('title').text() );
    metadata.title = $('meta[property="og:title"]').attr('content') || $('title').text() || url;

    metadata.description = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '';

    metadata.image = $('meta[property="og:image"]').attr('content') || '';

    const favicon = $('link[rel*="icon"]').attr('href');
    if (favicon) {
        let faviconUrl = favicon;
        if (!faviconUrl.startsWith('http')) {
            if (faviconUrl.startsWith('//')) {
                faviconUrl = 'https:' + faviconUrl;
            } else {
                faviconUrl = new URL(faviconUrl, url).href;
            }
        }
        metadata.favicon = faviconUrl;
    }

    await pubClient.set(cacheKey, JSON.stringify(metadata));
    await pubClient.expire(cacheKey, 31536000);  // 365 days in seconds

    return metadata;


};

app.post('/api/subscriptions', async (req, res) => {
    const { roomId, subscription } = req.body;

    if (!roomId || !subscription) {
        return res.status(400).json({ error: 'roomId and subscription are required.' });
    }

    try {
        const key = `room:${roomId}:subscriptions`;
        // Store subscription by endpoint to ensure uniqueness
        await pubClient.hSet(key, subscription.endpoint, JSON.stringify(subscription));
        return res.json({ message: 'Subscription stored successfully!' });
    } catch (error) {
        console.error('Error storing subscription:', error);
        return res.status(500).json({ error: 'Failed to store subscription.' });
    }
});

// Retrieve subscriptions for a room
app.get('/api/subscriptions', async (req, res) => {
    const { roomId } = req.query;
    if (!roomId) {
        return res.status(400).json({ error: 'roomId is required.' });
    }

    try {
        const key = `room:${roomId}:subscriptions`;
        const subsHash = await pubClient.hGetAll(key);
        const subscriptions = Object.values(subsHash).map(val => JSON.parse(val));
        return res.json(subscriptions);
    } catch (error) {
        console.error('Error fetching subscriptions:', error);
        return res.status(500).json({ error: 'Failed to fetch subscriptions.' });
    }
});

app.post('/api/linkPreview', async (req, res) => {
    const data = req.body;
    if (!data || !data.url || !data.messageId) {
        return res.status(400).json({ error: 'URL and Message Id is required' });
    }

    const {url, messageId} = data;
    try {
        const metadata = await extractMetadata(url, messageId);
        return res.json(metadata);
    } catch (error) {
        return res.status(500).json({ error: 'Failed to fetch metadata.' });
    }
});
