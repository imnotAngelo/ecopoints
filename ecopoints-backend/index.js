import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { supabase } from './config/supabase.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Test Supabase connection
const testConnection = async () => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('count');
    
    if (error) throw error;
    console.log('Supabase connected successfully');
  } catch (err) {
    console.error('Supabase connection error:', err);
    process.exit(1);
  }
};

testConnection();

// Example login endpoint using Supabase
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .single();

    if (error || !user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, is_admin: user.is_admin },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        is_admin: user.is_admin
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error during login' });
  }
});

// Add this after your imports
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Update the register endpoint
app.post('/api/register', async (req, res) => {
  const { name, username, password } = req.body;

  try {
    // Validate password strength
    if (password.length < 6) {
      return res.status(400).json({
        message: 'Registration failed',
        error: 'weak_password: Password should be at least 6 characters long'
      });
    }

    // Convert username to email format if it's not already
    const email = username.includes('@') ? username : `${username}@ecopoints.com`;

    // Create auth user in Supabase
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email: email,
      password,
      options: {
        data: {
          username: username,
          name: name
        }
      }
    });

    if (authError) {
      if (authError.message.includes('weak')) {
        return res.status(400).json({
          message: 'Registration failed',
          error: 'weak_password: ' + authError.message
        });
      }
      throw authError;
    }

    // Hash password for users table
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create user profile
    const { data: newUser, error: insertError } = await supabase
      .from('users')
      .insert([{
        id: authData.user.id,
        name,
        username,
        password: hashedPassword,
        points: 0,
        money: 0,
        is_admin: false
      }])
      .select()
      .single();

    if (insertError) throw insertError;

    // Generate JWT token
    const token = jwt.sign(
      { id: newUser.id, username: newUser.username },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(201).json({
      message: 'Registration successful',
      token,
      user: {
        id: newUser.id,
        name: newUser.name,
        username: newUser.username
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      message: 'Registration failed',
      error: error.message
    });
  }
});

app.get('/api/notifications', async (req, res) => {
  const { userId } = req.query;
  try {
    const { data: notifications, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .eq('is_read', false)
      .order('created_at', { ascending: false })
      .limit(5);

    if (error) throw error;

    res.json(notifications);
  } catch (error) {
    console.error('Notifications error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get user points
app.get('/api/user-points/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { data: user, error } = await supabase
      .from('users')
      .select('points')
      .eq('id', userId)
      .single();

    if (error) throw error;

    res.json({ points: user?.points || 0 });
  } catch (error) {
    console.error('Error fetching points:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get user stats endpoint
app.get('/api/user-stats/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { data: userStats, error } = await supabase
      .rpc('get_user_stats', { user_id: userId })
      .single();

    if (error) throw error;

    if (!userStats) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json(userStats);
  } catch (error) {
    console.error('Error fetching user stats:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Submit redemption request
app.post('/api/redeem-request', async (req, res) => {
  try {
    const { userId, points, status } = req.body;

    const { data: redemptionRequest, error: insertError } = await supabase
      .from('redemption_requests')
      .insert([{
        user_id: userId,
        points,
        status
      }])
      .single();

    if (insertError) throw insertError;

    // Notify admins (you can implement this through websockets or email)
    const { error: notifyError } = await supabase
      .from('notifications')
      .insert([{
        user_id: userId,
        message: `New redemption request for ${points} points from user ${userId}`,
        type: 'redemption_request'
      }]);

    if (notifyError) throw notifyError;

    res.json({ message: 'Redemption request created successfully' });
  } catch (error) {
    console.error('Error creating redemption request:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get pending redemptions for a user
app.get('/api/pending-redemptions/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { data: pendingRedemptions, error } = await supabase
      .from('redemption_requests')
      .select('id, points, status, created_at')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json(pendingRedemptions);
  } catch (error) {
    console.error('Error fetching pending redemptions:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Use middleware for admin routes
app.get('/api/admin/users', async (req, res) => {
  try {
    const adminId = req.headers.authorization?.split(' ')[1];

    if (!adminId) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const { data: adminCheck, error: adminError } = await supabase
      .from('users')
      .select('is_admin')
      .eq('id', adminId)
      .single();

    if (adminError || !adminCheck?.is_admin) {
      return res.status(403).json({ message: 'Unauthorized access' });
    }

    const { data: users, error } = await supabase
      .rpc('get_admin_users')
      .order('id');

    if (error) throw error;

    res.json(users);
  } catch (error) {
    console.error('Admin users error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/admin/pending-redemptions', async (req, res) => {
  try {
    const adminId = req.headers.authorization?.split(' ')[1];

    if (!adminId) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const { data: adminCheck, error: adminError } = await supabase
      .from('users')
      .select('is_admin')
      .eq('id', adminId)
      .single();

    if (adminError || !adminCheck?.is_admin) {
      return res.status(403).json({ message: 'Unauthorized access' });
    }

    const { data: pendingRedemptions, error } = await supabase
      .rpc('get_pending_redemptions')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json(pendingRedemptions);
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ message: 'Error fetching pending redemptions' });
  }
});

app.get('/api/admin/approved-redemptions', async (req, res) => {
  try {
    const adminId = req.headers.authorization?.split(' ')[1];

    if (!adminId) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const { data: adminCheck, error: adminError } = await supabase
      .from('users')
      .select('is_admin')
      .eq('id', adminId)
      .single();

    if (adminError || !adminCheck?.is_admin) {
      return res.status(403).json({ message: 'Unauthorized access' });
    }

    const { data: approvedRedemptions, error } = await supabase
      .rpc('get_approved_redemptions')
      .order('processed_at', { ascending: false });

    if (error) throw error;

    res.json(approvedRedemptions);
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ message: 'Error fetching approved redemptions' });
  }
});

// Get user transactions endpoint
app.get('/api/transactions/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const { data: userCheck, error: userError } = await supabase
      .from('users')
      .select('id')
      .eq('id', userId)
      .single();

    if (userError || !userCheck) {
      return res.status(404).json({ message: 'User not found' });
    }

    const { data: transactions, error } = await supabase
      .rpc('get_user_transactions', { user_id: userId });

    if (error) throw error;

    res.json(transactions);
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ message: 'Error fetching transaction history' });
  }
});

app.put('/api/admin/recyclables/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { points_per_piece } = req.body;
    const adminId = req.headers.authorization?.split(' ')[1];

    if (!adminId) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const { data: adminCheck, error: adminError } = await supabase
      .from('users')
      .select('is_admin')
      .eq('id', adminId)
      .single();

    if (adminError || !adminCheck?.is_admin) {
      return res.status(403).json({ message: 'Unauthorized access' });
    }

    const { error } = await supabase
      .from('recyclables')
      .update({ points_per_piece })
      .eq('id', id);

    if (error) throw error;

    res.json({ message: 'Value updated successfully' });
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ message: 'Error updating recyclable value' });
  }
});

app.get('/api/admin/recyclables', async (req, res) => {
  try {
    const adminId = req.headers.authorization?.split(' ')[1];

    if (!adminId) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const { data: adminCheck, error: adminError } = await supabase
      .from('users')
      .select('is_admin')
      .eq('id', adminId)
      .single();

    if (adminError || !adminCheck?.is_admin) {
      return res.status(403).json({ message: 'Unauthorized access' });
    }

    const { data: recyclables, error } = await supabase
      .from('recyclables')
      .select('id, name, points_per_piece')
      .order('name');

    if (error) throw error;

    res.json(recyclables);
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ message: 'Error fetching recyclables' });
  }
});

app.post('/api/admin/process-redemption', async (req, res) => {
  try {
    const { requestId, adminId, status } = req.body;

    if (!requestId || !adminId || !status) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const { data: adminCheck, error: adminError } = await supabase
      .from('users')
      .select('is_admin')
      .eq('id', adminId)
      .single();

    if (adminError || !adminCheck?.is_admin) {
      return res.status(403).json({ message: 'Unauthorized access' });
    }

    const { data: request, error: updateError } = await supabase
      .from('redemption_requests')
      .update({
        status,
        processed_by: adminId,
        processed_at: new Date().toISOString()
      })
      .eq('id', requestId)
      .eq('status', 'pending')
      .single();

    if (updateError) throw updateError;

    if (status === 'approved') {
      const { error: balanceError } = await supabase
        .from('users')
        .update({ money: supabase.raw('money + ?', [request.points]) })
        .eq('id', request.user_id);

      if (balanceError) throw balanceError;
    }

    res.json({ message: `Request ${status} successfully`, request });
  } catch (error) {
    console.error('Process redemption error:', error);
    res.status(500).json({ message: error.message || 'Failed to process redemption request' });
  }
});

app.post('/api/auth/signup', async (req, res) => {
  const { email, password, name } = req.body;

  try {
    // 1. Create auth user in Supabase
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          name,
        }
      }
    });

    if (authError) throw authError;

    // 2. Create user profile in your users table
    const { data: profileData, error: profileError } = await supabase
      .from('users')
      .insert([{
        id: authData.user.id,
        email: email,
        name: name,
        points: 0,
        money: 0,
        is_admin: false
      }])
      .single();

    if (profileError) throw profileError;

    res.status(201).json({
      message: 'Registration successful! Please check your email for verification.',
      user: authData.user
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      message: 'Registration failed',
      error: error.message
    });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});