// Add at the top with other imports
const { authenticateToken } = require('./middleware/auth');
const UserManager = require('./models/User');
const userManager = new UserManager();

// Add authentication middleware
io.use(authenticateToken);

// Update connection handler
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id} - ${socket.user.username}`);
  
  // Handle user joining with authentication
  socket.on('user_join', (userData) => {
    userManager.addUser(socket.id, {
      ...socket.user,
      ...userData
    });
    
    // Join default room
    socket.join('general');
    userManager.joinRoom(socket.id, 'general');
    
    io.emit('user_list', userManager.getAllUsers());
    io.emit('user_joined', userManager.getUser(socket.id));
    
    // Send room list
    socket.emit('room_list', ['general', 'random', 'tech']);
  });

  // Handle room joining
  socket.on('join_room', (roomId) => {
    const previousRoom = userManager.userRooms.get(socket.id);
    
    if (previousRoom) {
      socket.leave(previousRoom);
      socket.to(previousRoom).emit('user_left_room', {
        user: userManager.getUser(socket.id),
        room: previousRoom
      });
    }
    
    socket.join(roomId);
    userManager.joinRoom(socket.id, roomId);
    
    socket.emit('room_joined', roomId);
    socket.to(roomId).emit('user_joined_room', {
      user: userManager.getUser(socket.id),
      room: roomId
    });
    
    // Send room-specific user list
    io.to(roomId).emit('room_users', userManager.getUsersInRoom(roomId));
  });

  // Enhanced message handling with rooms
  socket.on('send_message', (messageData) => {
    const user = userManager.getUser(socket.id);
    const roomId = userManager.userRooms.get(socket.id) || 'general';
    
    const message = {
      ...messageData,
      id: Date.now() + Math.random(),
      sender: user?.username || 'Anonymous',
      senderId: socket.id,
      room: roomId,
      timestamp: new Date().toISOString(),
    };
    
    // Store message with room context
    messages.push(message);
    
    // Limit stored messages
    if (messages.length > 1000) {
      messages.splice(0, 100);
    }
    
    // Send to room only
    io.to(roomId).emit('receive_message', message);
    
    // Send delivery receipt
    socket.emit('message_delivered', { 
      messageId: message.id, 
      timestamp: new Date().toISOString() 
    });
  });

  // Enhanced typing indicator with rooms
  socket.on('typing', (isTyping) => {
    const user = userManager.getUser(socket.id);
    const roomId = userManager.userRooms.get(socket.id);
    
    if (user && roomId) {
      if (isTyping) {
        typingUsers[socket.id] = {
          username: user.username,
          room: roomId
        };
      } else {
        delete typingUsers[socket.id];
      }
      
      // Send to room only
      socket.to(roomId).emit('typing_users', 
        Object.values(typingUsers)
          .filter(u => u.room === roomId)
          .map(u => u.username)
      );
    }
  });

  // Enhanced private messaging
  socket.on('private_message', ({ to, message }) => {
    const fromUser = userManager.getUser(socket.id);
    const toUser = userManager.getUserByUsername(to);
    
    if (!toUser) {
      return socket.emit('error', { message: 'User not found' });
    }
    
    const messageData = {
      id: Date.now() + Math.random(),
      from: fromUser.username,
      fromId: socket.id,
      to: to,
      toId: toUser.id,
      message,
      timestamp: new Date().toISOString(),
      isPrivate: true,
    };
    
    // Send to recipient
    socket.to(toUser.id).emit('private_message', messageData);
    // Send back to sender
    socket.emit('private_message', messageData);
    
    // Send read receipt when recipient views the message
    setTimeout(() => {
      socket.to(toUser.id).emit('message_read', { 
        messageId: messageData.id 
      });
    }, 1000);
  });

  // File sharing handler
  socket.on('send_file', (fileData) => {
    const user = userManager.getUser(socket.id);
    const roomId = userManager.userRooms.get(socket.id);
    
    const message = {
      id: Date.now() + Math.random(),
      sender: user.username,
      senderId: socket.id,
      file: fileData,
      timestamp: new Date().toISOString(),
      type: 'file',
      room: roomId
    };
    
    messages.push(message);
    io.to(roomId).emit('receive_message', message);
  });

  // Message reactions
  socket.on('message_reaction', ({ messageId, reaction }) => {
    const messageIndex = messages.findIndex(m => m.id === messageId);
    if (messageIndex !== -1) {
      if (!messages[messageIndex].reactions) {
        messages[messageIndex].reactions = {};
      }
      
      const user = userManager.getUser(socket.id);
      messages[messageIndex].reactions[user.username] = reaction;
      
      // Broadcast reaction to all users in room
      const roomId = messages[messageIndex].room;
      io.to(roomId).emit('message_updated', messages[messageIndex]);
    }
  });

  // Enhanced disconnection
  socket.on('disconnect', () => {
    const user = userManager.removeUser(socket.id);
    
    if (user) {
      const roomId = userManager.userRooms.get(socket.id);
      
      io.emit('user_left', user);
      if (roomId) {
        socket.to(roomId).emit('user_left_room', { user, room: roomId });
      }
      
      console.log(`${user.username} left the chat`);
    }
    
    delete typingUsers[socket.id];
    
    io.emit('user_list', userManager.getAllUsers());
    io.emit('typing_users', Object.values(typingUsers));
  });
});

// New API routes for messages with pagination
app.get('/api/messages/:room', (req, res) => {
  const { room } = req.params;
  const { page = 1, limit = 50 } = req.query;
  
  const roomMessages = messages
    .filter(m => m.room === room)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  
  const startIndex = (page - 1) * limit;
  const endIndex = page * limit;
  
  const result = {
    messages: roomMessages.slice(startIndex, endIndex),
    total: roomMessages.length,
    page: parseInt(page),
    totalPages: Math.ceil(roomMessages.length / limit)
  };
  
  res.json(result);
});

// Search messages
app.get('/api/messages/search/:query', (req, res) => {
  const { query } = req.params;
  const { room } = req.query;
  
  const searchResults = messages.filter(message => {
    const matchesRoom = !room || message.room === room;
    const matchesQuery = message.message && 
      message.message.toLowerCase().includes(query.toLowerCase());
    
    return matchesRoom && matchesQuery;
  });
  
  res.json(searchResults.slice(-50)); // Return last 50 matches
});