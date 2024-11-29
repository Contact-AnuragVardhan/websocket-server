//index.js 
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const redis = require('redis');
const retry = require('async-retry');

const logger = require('./logger');

const app = express();
app.use(
    cors({
        origin: '*',
        methods: ['GET', 'POST'],
    })
);

const server = http.createServer(app);

const pubClient = redis.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
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
        /*if(isMobileDebug) {
            server.listen(PORT, '0.0.0.0', () => {
                logger.info(`WebSocket server running on port ${PORT}`);
            });
        } else {*/
        server.listen(PORT, () => {
            logger.info(`WebSocket server running on port ${PORT}`);
        });
        //}


        io.on('connection', (socket) => {
            logger.info(`User connected: ${socket.id}`);

            socket.on('user_connected', async ({ username }) => {
                handleSocketInitialization(socket, username);

                await pubClient.sAdd(`user:${username}:sockets`, socket.id);
                logger.info(`New socketId is ${socket.id} for username ${username}`);

                // Rejoin all rooms the user was part of
                const userRooms = await pubClient.sMembers(`user:${username}:rooms`);

                for (const room of userRooms) {
                    handleSocketInitialization(socket, username, room);
                    logger.info(`User ${username} rejoined room ${room}`);

                    /*const latestMessage = await getMessageNotificationForRoom(username, room);
                    if (latestMessage) {
                        if(latestMessage.author !== username) {
                            socket.emit('new_message_notification', { room, message: latestMessage });
                        }
                        else {
                            logger.info(`${latestMessage} not sent to ${username} as ${username} is the Author.`);
                        }
                    }*/
                }
            });

            socket.on('create_room', async ({ room, username }) => {
                try {
                    const roomExists = await pubClient.exists(`room:${room}:users`);
                    if (!roomExists) {
                        await createRoom(room, username, socket, 'create_room');
                    } else {
                        logger.info(`Room ${room} already exists`);
                        await addUserInRoom(room, username, socket, 'create_room');
                    }
                    socket.emit('joined_room', { room });
                } catch (error) {
                    logger.error('Error creating room:', error);
                    socket.emit('error_message', { message: 'Failed to create room.' });
                }
            });

            socket.on('join_room', async ({ room, username }) => {
                try {
                    const roomExists = await pubClient.exists(`room:${room}:users`);
                    if (roomExists) {
                        await addUserInRoom(room, username, socket, 'join_room');
                    } else {
                        await createRoom(room, username, socket, 'join_room');
                    }
                    socket.emit('joined_room', { room });
                } catch (error) {
                    logger.error('Error joining room:', error);
                    socket.emit('error_message', { message: 'Failed to join room.' });
                }
            });

            socket.on('send_message', (data) => {
                const room = data.room;
                const username = data.author;

                handleSocketInitialization(socket, username, room);
            
                pubClient.exists(`room:${room}:users`)
                    .then((roomExists) => {
                        if (!roomExists) {
                            return createRoom(room, username, socket, 'send_message');
                        } else {
                            return addUserInRoom(room, username, socket, 'send_message');
                        }
                    })
                    .then(() => {
                        addMessage(data, 'user');
                    })
                    .catch((error) => {
                        logger.error('Error sending message:', error);
                        socket.emit('error_message', { message: 'Failed to send message.' });
                    });
            });

            /*socket.on('send_message', async (data) => {
                const room = data.room;
                const username = data.author;

                try {

                    //socket.emit('joined_room', { room });

                    const roomExists = await pubClient.exists(`room:${room}:users`);
                    if (!roomExists) {
                        await createRoom(room, username, socket, 'send_message');
                    } else {
                        await addUserInRoom(room, username, socket, 'send_message');
                    }
                    addMessage(data, 'user');
                } catch (error) {
                    logger.error('Error sending message:', error);
                    socket.emit('error_message', { message: 'Failed to send message.' });
                }
            });*/

            socket.on('get_user_rooms', ({ username }) => {
                handleSocketInitialization(socket, username);
                getUserRooms(username, socket);
            });

            socket.on('get_user_in_rooms', ({ room }) => {
                getAllUserInRooms(room, socket);
            });

            socket.on('get_room_messages', ({ room, username }) => {
                getRoomMessages(room, -1, -1, socket, username)
                    .then((messages) => {
                        socket.emit('message_history', { room, messages });
                    })
                    .catch((error) => {
                        socket.emit('error_message', { message: 'Failed to get room messages.' });
                    });
            });
            
            socket.on('get_room_messages_pages', ({ room, page = 1, pageSize = 50, username }) => {
                getRoomMessages(room, page, pageSize, socket, username)
                    .then((messages) => {
                        socket.emit('message_history_pages', { room, messages, page, pageSize });
                    })
                    .catch((error) => {
                        socket.emit('error_message_pages', { message: 'Failed to get room messages.' });
                    });
            });

            /*socket.on('get_room_messages', async ({ room }) => {
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
            });*/

            socket.on('get_all_rooms', () => {
                getAllRooms(socket);
            });

            socket.on('update_last_read_message', ({ room, username }) => {
                logger.info(`Updating Last Read Message for Room ${room} for User ${username}`);
                handleSocketInitialization(socket, username);
                
                pubClient.lLen(`room:${room}:messages`)
                    .then((totalMessages) => {
                        return pubClient.lIndex(`room:${room}:messages`, totalMessages - 1)
                            .then((latestMessageData) => {
                                const latestMessage = JSON.parse(latestMessageData);
                                if (latestMessage) {
                                    return pubClient.set(`user:${socket.username || username}:room:${room}:lastReadMessage`, latestMessage.time);
                                }
                            });
                    })
                    .catch((error) => {
                        logger.error('Error updating last read message:', error);
                    });
            });
            

            /*socket.on('update_last_read_message', async ({ room, username }) => {
                try {
                    logger.info(`Updating Last Read Message for Room ${room} for User ${username}`);
                    const totalMessages = await pubClient.lLen(`room:${room}:messages`);
                    const latestMessageData = await pubClient.lIndex(`room:${room}:messages`, totalMessages - 1);
                    const latestMessage = JSON.parse(latestMessageData);

                    if (latestMessage) {
                        await pubClient.set(`user:${socket.username || username}:room:${room}:lastReadMessage`, latestMessage.time);
                    }
                } catch (error) {
                    logger.error('Error updating last read message:', error);
                }
            });*/

            socket.on('disconnect', () => {
                const username = socket.username;
            
                if (username) {
                    logger.info(`SocketId ${socket.id} is getting deleted for username ${username}`);
                    pubClient.sRem(`user:${username}:sockets`, socket.id)
                        .catch((error) => {
                            logger.error('Error during disconnect:', error);
                        });
                    logger.info(`User disconnected: ${socket.id}`);
                }
                else {
                    logger.info(`In disconnect Socket username not set for socket ID ${socket.id}`);
                }
            });
            

            /*socket.on('disconnect', async () => {
                const username = socket.username;

                if (username) {
                    try {
                        logger.info(`SocketId is ${socket.id} is getting deleted for username ${username}`);
                        await pubClient.sRem(`user:${username}:sockets`, socket.id);
                    } catch (error) {
                        logger.error('Error during disconnect:', error);
                    }
                }
                logger.info(`User disconnected: ${socket.id}`);
            });*/
        });
    } catch (error) {
        logger.error('Error connecting to Redis:', error);
    }
})();

const createRoom = async (room, username, socket, fromEvent) => {
    handleSocketInitialization(socket, username, room);
    const roomExists = await pubClient.exists(`room:${room}:users`);
    if (!roomExists) {
        logger.info(`Creating Room ${room} in ${fromEvent} event`);
        //socket.join(room);
        //socket.username = username;
        await pubClient.sAdd(`room:${room}:users`, username);
        await pubClient.sAdd(`user:${username}:rooms`, room);
        await pubClient.sAdd('rooms:set', room);

        // Emit to all clients that a new room has been created
        io.emit('room_created', { room });
        addDefaultMessage(room, username, `${room} created by ${username}`);

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
        //socket.join(room);
        //socket.username = username;
        addDefaultMessage(room, username, `${username} joined the ${room}`);

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
        socket.emit('error_message', { message: `Failed to get users in room ${room}` });
    }
};

const getUserRooms = async (username, socket) => {
    try {
        const rooms = await pubClient.sMembers(`user:${username}:rooms`);
        const userRooms = await Promise.all(
            rooms.map(async (room) => {
                const latestMessage = await getMessageNotificationForRoom(username, room);
                return { room, latestMessage };
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
        socket.emit('error_message', { message: 'Failed to get user rooms.' });
    }
};

const getRoomMessages = async (room, page = 1, pageSize = 50, socket, username) => {
    try {
        handleSocketInitialization(socket, username);
        const totalMessages = await pubClient.lLen(`room:${room}:messages`);

        const end = totalMessages - (page - 1) * pageSize - 1;
        const start = Math.max(0, end - pageSize + 1);

        logger.info(
            `Total Message for room ${room} is ${totalMessages} and returning messages from ${start} to ${end} 
      with parameters Page ${page} and Page Size ${pageSize}`
        );

        if (start > end || end < 0) {
            return [];
        }

        const storedMessages = await pubClient.lRange(`room:${room}:messages`, start, end);
        const messages = storedMessages.map((msg) => JSON.parse(msg));
        if (messages && messages.length > 0 && messages[messages.length - 1]) {
            const lastMessage = messages[messages.length - 1];
            await pubClient.set(`user:${socket.username}:room:${room}:lastReadMessage`, lastMessage.time);
        }
        logger.info(
            `Start Message is ${JSON.stringify(messages[0])} and end Message is ${JSON.stringify(
                messages[messages.length - 1]
            )}`
        );
        return messages;
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
        socket.emit('error_message', { message: 'Failed to get all room list.' });
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

            /*if (messageType !== 'system') {
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
            }*/
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
    const lastReadMessageId = await pubClient.get(`user:${username}:room:${room}:lastReadMessage`);
    const totalMessages = await pubClient.lLen(`room:${room}:messages`);
    const latestMessageData = await pubClient.lIndex(`room:${room}:messages`, totalMessages - 1);
    const latestMessage = JSON.parse(latestMessageData);

    if (lastReadMessageId && isValidDate(lastReadMessageId) && latestMessage) {
        const latestMessageTime = new Date(latestMessage.time);
        const lastReadMessageIdTime = new Date(lastReadMessageId);
        if (latestMessageTime > lastReadMessageIdTime) {
            return latestMessage;
        }
    }
    return null;
};

const handleSocketInitialization = (socket, username, room) => {
    if(socket) {
        if(room) {
            // Since socket.join(room) is idempotent we can always use socket.join(room) without checking it
            socket.join(room);
        }
        if (username) {
            socket.username = username;
        }
    }
}

const isValidDate = (dateString) => {
    const date = new Date(dateString);
    const retVal = !isNaN(date.getTime());
    return retVal;
};