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

const {
    setupAudioEvents,
    removeAudioEvents
} = require('./audioHandlers'); 

const { 
    setupScreenShareEvents,
    removeScreenShareEvents
} = require('./screenshareHandlers');

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

// new code: store userId -> username
async function storeUserIdAndUsername(userId, username) {
    if (!userId || !username) return;
    try {
        await pubClient.set(`userId:${userId}:username`, username);
    } catch (error) {
        logger.error('Error storing userId <-> username', error);
    }
}

// new code: get username from userId
async function getUsernameFromUserId(userId) {
    if (!userId) return null;
    try {
        const uname = await pubClient.get(`userId:${userId}:username`);
        return uname;
    } catch (error) {
        logger.error('Error getting username from userId:', error);
        return null;
    }
}

(async () => {
    try {
        await pubClient.connect();
        await subClient.connect();
        logger.info('Connected to Redis');

        io.adapter(createAdapter(pubClient, subClient));

        const PORT = process.env.PORT || 3001;
        const isMobileDebug = false;
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

            socket.on('user_connected', async ({ userId, username }) => {
                // new code: store userId <-> username
                validateUser(userId, username, 'user_connected');
                storeUserIdAndUsername(userId, username);

                handleSocketInitialization(socket, userId, username, null);

                // new code: track sockets by userId
                await pubClient.sAdd(`userId:${userId}:sockets`, socket.id);
                logger.info(`New socketId is ${socket.id} for userId ${userId}, username ${username}`);

                // Rejoin all rooms the user was part of
                const userRooms = await pubClient.sMembers(`userId:${userId}:rooms`);
                for (const room of userRooms) {
                    handleSocketInitialization(socket, userId, username, room);
                    logger.info(`UserId ${userId}, username ${username} rejoined room ${room}`);
                }
            });

            socket.on('create_room', async ({ room, userId, username, initialMessages }) => {
                try {
                    validateUser(userId, username, 'create_room');
                    storeUserIdAndUsername(userId, username);

                    const roomExists = await pubClient.exists(`room:${room}:users`);
                    if (!roomExists) {
                        await createRoom(room, userId, username, initialMessages, socket, 'create_room');
                    } else {
                        logger.info(`Room ${room} already exists`);
                        await addUserInRoom(room, userId, username, socket, 'create_room');
                    }
                    socket.emit('joined_room', { room });
                } catch (error) {
                    logger.error('Error creating room:', error);
                    socket.emit('error_message', { message: 'Failed to create room.', error });
                }
            });

            socket.on('join_room', async ({ room, userId, username }) => {
                try {
                    validateUser(userId, username, 'join_room');
                    storeUserIdAndUsername(userId, username);

                    const roomExists = await pubClient.exists(`room:${room}:users`);
                    if (roomExists) {
                        await addUserInRoom(room, userId, username, socket, 'join_room');
                        socket.emit('joined_room', { room });
                    } else {
                        //await createRoom(room, userId, username, null, socket, 'join_room');
                        socket.emit('room_not_valid', { room });
                    }
                    
                } catch (error) {
                    logger.error('Error joining room:', error);
                    socket.emit('error_message', { message: 'Failed to join room.', error });
                }
            });

            socket.on('send_message', (data) => {
                const { room, userId, author: username } = data;
                // 'author' is the username for display

                validateUser(userId, username, 'send_message');
                handleSocketInitialization(socket, userId, username, room);

                // new code: store userId -> username
                storeUserIdAndUsername(userId, username);

                pubClient.exists(`room:${room}:users`)
                    .then((roomExists) => {
                        if (!roomExists) {
                            return createRoom(room, userId, username, null, socket, 'send_message');
                        } else {
                            return addUserInRoom(room, userId, username, socket, 'send_message');
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

            socket.on('get_user_rooms', async ({ userId, username }) => {
                validateUser(userId, username, 'get_user_rooms');
                storeUserIdAndUsername(userId, username);

                handleSocketInitialization(socket, userId, username, null);
                getUserRooms(userId, socket);
            });

            socket.on('get_user_in_rooms', ({ room }) => {
                getAllUserInRooms(room, socket);
            });

            socket.on('get_room_messages', async ({ room, userId, username }) => {
                validateUser(userId, username, 'get_room_messages');
                storeUserIdAndUsername(userId, username);

                getRoomMessages(room, -1, -1, socket, userId, username)
                    .then(({ messages, totalMessages }) => {
                        socket.emit('message_history', { room, messages, totalMessages });
                    })
                    .catch((error) => {
                        socket.emit('error_message', { message: 'Failed to get room messages.', error });
                    });
            });

            socket.on('get_room_messages_pages', async ({ room, page = 1, pageSize = 50, userId, username }) => {
                validateUser(userId, username, 'get_room_messages_pages');
                storeUserIdAndUsername(userId, username);

                getRoomMessages(room, page, pageSize, socket, userId, username)
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

            socket.on('update_last_read_message', ({ room, userId, username }) => {
                validateUser(userId, username, 'update_last_read_message');
                storeUserIdAndUsername(userId, username);

                logger.info(`Updating Last Read Message for Room ${room} for userId ${userId}, username ${username}`);
                handleSocketInitialization(socket, userId, username, null);

                // new code: track last read for userId
                pubClient.set(`userId:${userId}:room:${room}:lastReadTime`, (new Date()).getTime());
                //keeping it for later like "watermark" or "read receipts" functionality
                pubClient.lLen(`room:${room}:messages`)
                    .then((totalMessages) => {
                        return pubClient.lIndex(`room:${room}:messages`, totalMessages - 1)
                            .then((latestMessageData) => {
                                const latestMessage = JSON.parse(latestMessageData);
                                if (latestMessage) {
                                    return pubClient.set(`userId:${userId}:room:${room}:lastReadMessage`, JSON.stringify(latestMessage));
                                }
                            });
                    })
                    .catch((error) => {
                        logger.error('Error updating last read message:', error);
                    });
            });

            // Audio call functionality
            setupAudioEvents(io, socket, pubClient);

            // Setup screen share events
            setupScreenShareEvents(io, socket, pubClient);

            
            socket.on('disconnect', async () => {
                const userId = socket.userId;
                if (userId) {
                    logger.info(`SocketId ${socket.id} is getting deleted for userId ${userId}`);
                    pubClient.sRem(`userId:${userId}:sockets`, socket.id)
                        .catch((error) => {
                            logger.error('Error during disconnect:', error);
                        });
                    logger.info(`User disconnected: ${socket.id}`);
                } else {
                    logger.info(`In disconnect Socket userId not set for socket ID ${socket.id}`);
                }

                // Handle call user disconnection
                await removeAudioEvents(io, pubClient, socket);

                await removeScreenShareEvents(io, pubClient, socket);
            });
        });

    } catch (error) {
        logger.error('Error connecting to Redis:', error);
    }
})();

const createRoom = async (room, userId, username, initialMessages, socket, fromEvent) => {
    handleSocketInitialization(socket, userId, username, room);
    const roomExists = await pubClient.exists(`room:${room}:users`);
    if (!roomExists) {
        logger.info(`Creating Room ${room} in ${fromEvent} event`);
        // new code: store userId in the room set
        await pubClient.sAdd(`room:${room}:users`, userId);
        // new code: store room in userId's set
        await pubClient.sAdd(`userId:${userId}:rooms`, room);

        await pubClient.sAdd('rooms:set', room);

        // Emit to all clients that a new room has been created
        io.emit('room_created', { room });
        const roomName = getRoomNameFromId(room);
        const message = username ? `${roomName} created by ${username}` : `${roomName} created`;
        addDefaultMessage(room, userId, username, message);

        //add initial messages to the room
        if (initialMessages && initialMessages.length > 0) {
            for (const msg of initialMessages) {
                addMessage(msg, 'user');
            }
        }

        const userIds = await pubClient.sMembers(`room:${room}:users`);
        const users = await Promise.all(
            userIds.map(async (id) => {
                const uname = await getUsernameFromUserId(id);
                return { userId: id, username: uname || null };
            })
        );
        io.to(room).emit('user_list', { room, users });
        getAllRooms(socket);
        getUserRooms(userId, socket);
        logger.info(`Room ${room} created by userId ${userId}, username ${username}`);
        return true;
    }
    return false;
};

const addUserInRoom = async (room, userId, username, socket, fromEvent) => {
    handleSocketInitialization(socket, userId, username, room);
    validateUser(userId, username);
    if(userId && username) {
        const userInRoom = await pubClient.sIsMember(`room:${room}:users`, userId);
        if (!userInRoom) {
            logger.info(`UserId ${userId}, username ${username} is not in room ${room}. Adding to room from event ${fromEvent}`);
            await pubClient.sAdd(`room:${room}:users`, userId);
            await pubClient.sAdd(`userId:${userId}:rooms`, room);

            const roomName = getRoomNameFromId(room);
            addDefaultMessage(room, userId, username, `${username} joined the ${roomName}`);

            const userIds = await pubClient.sMembers(`room:${room}:users`);
            const users = await Promise.all(
                userIds.map(async (id) => {
                    const uname = await getUsernameFromUserId(id);
                    return { userId: id, username: uname || null };
                })
            );
            io.to(room).emit('user_list', { room, users });
            getAllRooms(socket);
            getUserRooms(userId, socket);
            return true;
        }
    }
    return false;
};

const getAllUserInRooms = async (room, socket) => {
    try {
        const userIds = await pubClient.sMembers(`room:${room}:users`);
        const users = await Promise.all(
            userIds.map(async (id) => {
                const uname = await getUsernameFromUserId(id);
                return { userId: id, username: uname || null };
            })
        );
        socket.emit('users_in_room', { room, users });
    } catch (error) {
        logger.error(`Error getting users in room ${room}:`, error);
        socket.emit('error_message', { message: `Failed to get users in room ${room}`, error });
    }
};

const getUserRooms = async (userId, socket) => {
    try {
        const rooms = await pubClient.sMembers(`userId:${userId}:rooms`);
        const userRooms = await Promise.all(
            rooms.map(async (room) => {
                try {
                    const unreadMessages = await getMessageNotificationForRoom(userId, room);
                    const lastMessage = await getLastMessageForRoom(room);
                    return { room, latestMessages: unreadMessages, lastMessage };
                }
                catch (error) {
                    logger.error(`Could not room details of ${room}`, error);
                    return { room, latestMessage: null, lastMessage: null };
                }
            })
        );
        socket.emit('user_rooms', userRooms);
    } catch (error) {
        logger.error('Error getting user rooms:', error);
        socket.emit('error_message', { message: 'Failed to get user rooms.', error });
    }
};

const getRoomMessages = async (room, page = 1, pageSize = 50, socket, userId, username) => {
    const startTime = Date.now();
    try {
        handleSocketInitialization(socket, userId, username, room);

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
            return { messages: [], totalMessages };
        }

        const storedMessages = await pubClient.lRange(`room:${room}:messages`, start, end);
        const fetchMessagesTime = Date.now();
        logger.info(`Time taken for fetching messages: ${fetchMessagesTime - lenTime}ms`);

        pubClient.set(`userId:${userId}:room:${room}:lastReadTime`, (new Date()).getTime());

        const messages = storedMessages.map((msg) => JSON.parse(msg));
        if (messages && messages.length > 0 && messages[messages.length - 1]) {
            const lastMessage = messages[messages.length - 1];
            await pubClient.set(`userId:${userId}:room:${room}:lastReadMessage`, JSON.stringify(lastMessage));
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
            const userId = data.userId;

            // Store the message in Redis with expiration
            const messageData = {
                ...data,
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

            logger.info(`Message from userId ${userId}, username ${username} in room ${room}:`, data.message);
            logger.info(`added message ${JSON.stringify(messageData)}`);
            io.to(room).emit('receive_message', messageData);
            if (messageType !== 'system') {
                io.emit('new_message_notification_all', { room, message: messageData });
                // Notifying all users who are part of the room, even if they're not connected to the room
                const userIds = await pubClient.sMembers(`room:${room}:users`);
                for (const uid of userIds) {
                    const userSocketIds = await pubClient.sMembers(`userId:${uid}:sockets`);
                    logger.info(`userSocketIds for userId ${uid} are ${userSocketIds}`);
                    if (userSocketIds && userSocketIds.length > 0) {
                        // only notify if the author is different
                        if (userId !== uid) {
                            for (const userSocketId of userSocketIds) {
                                io.to(userSocketId).emit('new_message_notification', { room, message: messageData });
                            }
                        } else {
                            logger.info(`${JSON.stringify(messageData)} not sent to userId ${uid} as userId is the Author.`);
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

const addDefaultMessage = (room, userId, username, message) => {
    const date = new Date();
    const objMessage = {
        id: date.getTime(),
        room,
        userId: 'Blackbox',
        author: 'Blackbox',
        message,
        affectedUserName: username,
        affectedUserId: userId,

        time: date.toISOString(),
        messageType: 'system',
    };
    addMessage(objMessage, 'system');
};

const getLastMessageForRoom = async (room) => {
    const messageJson = await pubClient.lIndex(`room:${room}:messages`, -1);
    if (messageJson === null) {
        return null;
    }
    return JSON.parse(messageJson);
};

const getMessageNotificationForRoom = async (userId, room) => {
    const totalMessages = await pubClient.lLen(`room:${room}:messages`);
    if (totalMessages === 0) {
        return null;
    }
    let lastReadTimeString = await pubClient.get(`userId:${userId}:room:${room}:lastReadTime`);
    if (lastReadTimeString) {
        if (typeof lastReadTimeString === 'string') {
            lastReadTimeString = Number(lastReadTimeString);
        }
        const lastReadTime = new Date(lastReadTimeString);
        const storedMessages = await pubClient.lRange(`room:${room}:messages`, 0, -1);
        if (storedMessages && storedMessages.length > 0) {
            const unreadMessages = [];
            for (let i = storedMessages.length - 1; i >= 0; i--) {
                const msg = JSON.parse(storedMessages[i]);
                if (!msg?.time) {
                    continue;
                }
                const msgTime = new Date(msg.time);
                if (msgTime > lastReadTime) {
                    // Because we're going from newest to oldest to keep final array in ascending time order
                    unreadMessages.unshift(msg);
                } else {
                    break;
                }
            }
            return unreadMessages;
        }
    }
    return null;
};

const handleSocketInitialization = (socket, userId, username, room) => {
    if (socket) {
        if (room) {
            // Since socket.join(room) is idempotent we can always use socket.join(room) without checking it
            socket.join(room);
        }
        if (userId) {
            socket.userId = userId;
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

const validateUser = (userId, username, method) => {
    if (!userId) {
        logger.error(`******** UserId is empty. We might have issue with websocket in method ${method} ********`);
        //throw new Error(`UserId is empty in method ${method}`);
    }
    if (!username) {
        logger.error(`******** Username is empty. We might have issue with websocket in method ${method} ********`);
        //throw new Error(`UserName is empty in method ${method}`);
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

    const { url, messageId } = data;
    try {
        const metadata = await extractMetadata(url, messageId);
        return res.json(metadata);
    } catch (error) {
        return res.status(500).json({ error: 'Failed to fetch metadata.' });
    }
});