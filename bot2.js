// ============================================================================
// TRADING RISK MANAGEMENT BOT - SIMPLE FUNCTION VERSION
// ============================================================================
// This bot monitors your trading accounts 24/7 and automatically closes
// positions when risk limits are exceeded. It runs independently from the
// web dashboard and stores all data in MongoDB.
// ============================================================================

// Import required packages
const ccxt = require('ccxt'); // Library for connecting to crypto exchanges
const mongoose = require('mongoose'); // MongoDB database connection
const crypto = require('crypto'); // For decrypting API keys
require('dotenv').config();

// ============================================================================
// CONFIGURATION - Settings for the bot
// ============================================================================
const CONFIG = {
  // MongoDB connection string (where we store account data)
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017/trading_risk',
  
  // How often to check accounts (in milliseconds)
  // 5000 = 5 seconds
  CHECK_INTERVAL: 5000,
  
  // Secret key for decrypting API keys from database
  ENCRYPTION_SECRET: process.env.ENCRYPTION_SECRET,
};

// ============================================================================
// MONGODB DATABASE MODELS - Structure of data we store
// ============================================================================

// Schema = blueprint for how data should look
const AccountSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId, // Which user owns this account
  name: String, // Account name (e.g., "BingX Main")
  exchange: String, // Exchange name (e.g., "bingx", "binance")
  apiKey: String, // Encrypted API key
  apiSecret: String, // Encrypted API secret
  password: String, // Some exchanges need password (encrypted)
  options: mongoose.Schema.Types.Mixed, // Extra settings for exchange
  riskParams: { // Risk management rules
    dailyDrawdownLimit: Number, // Max % loss per day (e.g., 5%)
    maxDrawdownLimit: Number, // Max % loss total (e.g., 20%)
    maxLeverage: Number, // Max leverage allowed (e.g., 20x)
    maxOpenTrades: Number, // Max positions open at once (e.g., 3)
  },
  isActive: Boolean, // Is monitoring enabled?
  initialBalance: Number, // Starting balance (for calculating P&L)
  lastCheck: Date, // When did we last check this account?
});

// Schema for storing performance metrics (balance, P&L, etc.)
const MetricSchema = new mongoose.Schema({
  accountId: mongoose.Schema.Types.ObjectId, // Which account
  currentBalance: Number, // Current USDT balance
  totalPnL: Number, // Total profit/loss in dollars
  dailyPnL: Number, // Today's profit/loss in dollars
  totalDrawdownPercent: Number, // Total P&L as percentage
  dailyDrawdownPercent: Number, // Daily P&L as percentage
  openPositions: Number, // Number of open trades
  timestamp: { type: Date, default: Date.now }, // When was this recorded
});

// Schema for storing alerts/notifications
const AlertSchema = new mongoose.Schema({
  accountId: mongoose.Schema.Types.ObjectId, // Which account
  level: String, // 'info', 'warning', 'critical'
  message: String, // Alert text
  data: mongoose.Schema.Types.Mixed, // Additional data
  timestamp: { type: Date, default: Date.now }, // When it happened
  read: { type: Boolean, default: false }, // Has user seen it?
});

// Create models from schemas (models = how we interact with database)
const Account = mongoose.models.Account || mongoose.model('Account', AccountSchema);
const Metric = mongoose.models.Metric || mongoose.model('Metric', MetricSchema);
const Alert = mongoose.models.Alert || mongoose.model('Alert', AlertSchema);

// ============================================================================
// FUNCTION: Decrypt API Keys
// ============================================================================
// API keys are stored encrypted in database for security
// This function decrypts them so we can use them
function decryptApiKey(encryptedData) {
  // If no data, return null
  if (!encryptedData) return null;
  
  // Encryption settings
  const ALGORITHM = 'aes-256-gcm'; // AES-256 encryption algorithm
  const SECRET_KEY = CONFIG.ENCRYPTION_SECRET; // Our secret key
  
  // Convert base64 string to buffer
  const buffer = Buffer.from(encryptedData, 'base64');
  
  // Extract parts (salt, iv, tag, encrypted data)
  const salt = buffer.subarray(0, 64); // First 64 bytes = salt
  const iv = buffer.subarray(64, 80); // Next 16 bytes = initialization vector
  const tag = buffer.subarray(80, 96); // Next 16 bytes = authentication tag
  const encrypted = buffer.subarray(96); // Rest = encrypted data
  
  // Generate key from password + salt
  const key = crypto.pbkdf2Sync(SECRET_KEY, salt, 100000, 32, 'sha512');
  
  // Create decipher (decryption tool)
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  
  // Decrypt the data
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
  ]);
  
  // Return as string
  return decrypted.toString('utf8');
}

// ============================================================================
// FUNCTION: Connect to MongoDB Database
// ============================================================================
async function connectToDatabase() {
  try {
    // Connect to MongoDB
    await mongoose.connect(CONFIG.MONGODB_URI);
    console.log('✅ Connected to MongoDB database');
    return true;
  } catch (error) {
    console.error('❌ Failed to connect to database:', error.message);
    return false;
  }
}

// ============================================================================
// FUNCTION: Load All Active Accounts from Database
// ============================================================================
async function loadActiveAccounts() {
  try {
    // Find all accounts where isActive = true
    const accounts = await Account.find({ isActive: true });
    
    console.log(`📋 Found ${accounts.length} active account(s) in database`);
    
    // Return the accounts
    return accounts;
  } catch (error) {
    console.error('❌ Error loading accounts:', error.message);
    return [];
  }
}

// ============================================================================
// FUNCTION: Create Exchange Client
// ============================================================================
// This creates a connection to a crypto exchange (BingX, Binance, etc.)
function createExchangeClient(accountDoc) {
  try {
    // Decrypt the API credentials
    const apiKey = decryptApiKey(accountDoc.apiKey);
    const apiSecret = decryptApiKey(accountDoc.apiSecret);
    const password = accountDoc.password ? decryptApiKey(accountDoc.password) : undefined;
    
    // Get the exchange class from CCXT library
    // CCXT supports 100+ exchanges
    const ExchangeClass = ccxt[accountDoc.exchange];
    
    // If exchange not supported, throw error
    if (!ExchangeClass) {
      throw new Error(`Exchange ${accountDoc.exchange} not supported`);
    }
    
    // Create new exchange instance with credentials
    const exchange = new ExchangeClass({
      apiKey: apiKey, // API key
      secret: apiSecret, // API secret
      password: password, // Password (only some exchanges need this)
      enableRateLimit: true, // Respect exchange rate limits
      options: accountDoc.options || {}, // Additional options
    });
    
    console.log(`✅ Connected to ${accountDoc.exchange} (${accountDoc.name})`);
    
    // Return the exchange client
    return exchange;
  } catch (error) {
    console.error(`❌ Failed to create exchange client for ${accountDoc.name}:`, error.message);
    return null;
  }
}

// ============================================================================
// FUNCTION: Get Account Balance
// ============================================================================
// Fetch current balance from exchange
async function getAccountBalance(exchange, accountName) {
  try {
    // Fetch balance from exchange
    const balance = await exchange.fetchBalance();
    
    // Extract USDT balance (most common trading currency)
    const usdtBalance = balance.USDT?.total || balance.total?.USDT || 0;
    
    return parseFloat(usdtBalance);
  } catch (error) {
    console.error(`❌ [${accountName}] Error fetching balance:`, error.message);
    throw error;
  }
}

// ============================================================================
// FUNCTION: Get Open Positions
// ============================================================================
// Fetch all open trading positions from exchange
async function getOpenPositions(exchange, accountName) {
  try {
    // Fetch all positions
    const positions = await exchange.fetchPositions();
    
    // Filter out empty positions (positions with no size)
    const openPositions = positions.filter(pos => {
      const contracts = parseFloat(pos.contracts || 0);
      return contracts > 0;
    });
    
    return openPositions;
  } catch (error) {
    console.error(`❌ [${accountName}] Error fetching positions:`, error.message);
    return []; // Return empty array on error
  }
}

// ============================================================================
// FUNCTION: Close Single Position
// ============================================================================
// Close a specific trading position on exchange
async function closePosition(exchange, accountName, symbol, side) {
  try {
    // Create market order to close position
    // If position is LONG, we SELL to close
    // If position is SHORT, we BUY to close
    const order = await exchange.createOrder(
      symbol, // Trading pair (e.g., "BTC/USDT")
      'market', // Order type = market (execute immediately)
      side === 'long' ? 'sell' : 'buy', // Direction
      null, // Amount = null means close entire position
      null, // Price = null for market order
      { reduceOnly: true } // This flag means "only close, don't open new"
    );
    
    console.log(`✅ [${accountName}] Closed position: ${symbol}`);
    return order;
  } catch (error) {
    console.error(`❌ [${accountName}] Error closing ${symbol}:`, error.message);
    throw error;
  }
}

// ============================================================================
// FUNCTION: Close All Positions
// ============================================================================
// Emergency function to close all positions on an account
async function closeAllPositions(exchange, accountName) {
  try {
    // Get all open positions
    const positions = await getOpenPositions(exchange, accountName);
    
    // If no positions, nothing to do
    if (positions.length === 0) {
      console.log(`[${accountName}] No positions to close`);
      return;
    }
    
    console.log(`🔴 [${accountName}] Closing ${positions.length} position(s)...`);
    
    // Close each position one by one
    for (const position of positions) {
      await closePosition(exchange, accountName, position.symbol, position.side);
    }
    
    console.log(`✅ [${accountName}] All positions closed successfully`);
  } catch (error) {
    console.error(`❌ [${accountName}] Error closing all positions:`, error.message);
  }
}

// ============================================================================
// FUNCTION: Save Alert to Database
// ============================================================================
// Store an alert/notification in database for user to see
async function saveAlert(accountId, accountName, level, message, data = {}) {
  try {
    // Create alert in database
    await Alert.create({
      accountId: accountId,
      level: level, // 'info', 'warning', 'critical'
      message: message,
      data: data,
    });
    
    // Also print to console
    console.log(`🚨 [${accountName}] [${level.toUpperCase()}] ${message}`);
  } catch (error) {
    console.error(`❌ Error saving alert:`, error.message);
  }
}

// ============================================================================
// FUNCTION: Save Metrics to Database
// ============================================================================
// Store performance metrics (balance, P&L, etc.) in database
async function saveMetrics(accountId, metrics) {
  try {
    // Create new metric record
    await Metric.create({
      accountId: accountId,
      currentBalance: metrics.currentBalance,
      totalPnL: metrics.totalPnL,
      dailyPnL: metrics.dailyPnL,
      totalDrawdownPercent: metrics.totalDrawdownPercent,
      dailyDrawdownPercent: metrics.dailyDrawdownPercent,
      openPositions: metrics.openPositions,
    });
  } catch (error) {
    console.error(`❌ Error saving metrics:`, error.message);
  }
}

// ============================================================================
// FUNCTION: Check If New Day (Reset Daily Metrics)
// ============================================================================
// Check if it's a new day, and if so, reset daily P&L tracking
function checkIfNewDay(lastDayReset) {
  // Get today's date as string (e.g., "Mon Nov 05 2025")
  const today = new Date().toDateString();
  
  // Compare with last reset date
  if (today !== lastDayReset) {
    console.log(`📅 New day detected - resetting daily metrics`);
    return today; // Return new date
  }
  
  return lastDayReset; // Return old date (no change)
}

// ============================================================================
// FUNCTION: Monitor Single Account
// ============================================================================
// Main monitoring function for one account
async function monitorAccount(accountDoc, accountState) {
  // Get account info
  const accountId = accountDoc._id;
  const accountName = accountDoc.name;
  const riskParams = accountDoc.riskParams;
  
  try {
    // Check if it's a new day (reset daily metrics if needed)
    accountState.lastDayReset = checkIfNewDay(accountState.lastDayReset);
    const isNewDay = accountState.lastDayReset !== accountState.lastDayResetOld;
    if (isNewDay) {
      // Reset daily starting balance for new day
      accountState.dailyStartBalance = accountState.currentBalance || accountState.initialBalance;
      accountState.lastDayResetOld = accountState.lastDayReset;
    }
    
    // Get current balance from exchange
    const currentBalance = await getAccountBalance(accountState.exchange, accountName);
    
    // Get open positions from exchange
    const positions = await getOpenPositions(accountState.exchange, accountName);
    const openPositionsCount = positions.length;
    
    // Calculate profit/loss
    const totalPnL = currentBalance - accountState.initialBalance;
    const dailyPnL = currentBalance - accountState.dailyStartBalance;
    
    // Calculate as percentages
    const totalDrawdownPercent = (totalPnL / accountState.initialBalance) * 100;
    const dailyDrawdownPercent = (dailyPnL / accountState.dailyStartBalance) * 100;
    
    // Store current metrics
    const metrics = {
      currentBalance: currentBalance,
      totalPnL: totalPnL,
      dailyPnL: dailyPnL,
      totalDrawdownPercent: totalDrawdownPercent,
      dailyDrawdownPercent: dailyDrawdownPercent,
      openPositions: openPositionsCount,
    };
    
    // Update account state
    accountState.currentBalance = currentBalance;
    accountState.metrics = metrics;
    
    // Print status to console
    console.log(
      `[${new Date().toLocaleTimeString()}] [${accountName}] ` +
      `Balance: $${currentBalance.toFixed(2)} | ` +
      `Daily: ${dailyDrawdownPercent.toFixed(2)}% | ` +
      `Total: ${totalDrawdownPercent.toFixed(2)}% | ` +
      `Positions: ${openPositionsCount}`
    );
    
    // Save metrics to database
    await saveMetrics(accountId, metrics);
    
    // Update last check time in database
    accountDoc.lastCheck = new Date();
    await accountDoc.save();
    
    // ===== RISK CHECKS =====
    
    // RISK CHECK 1: Daily Drawdown Limit
    // If we lost more than X% today, close all positions
    if (Math.abs(dailyDrawdownPercent) >= riskParams.dailyDrawdownLimit) {
      await saveAlert(
        accountId,
        accountName,
        'critical',
        `🚨 DAILY DRAWDOWN LIMIT REACHED: ${dailyDrawdownPercent.toFixed(2)}%`,
        { limit: riskParams.dailyDrawdownLimit, actual: dailyDrawdownPercent }
      );
      
      console.log(`🔴 [${accountName}] CLOSING ALL POSITIONS - Daily limit exceeded`);
      await closeAllPositions(accountState.exchange, accountName);
    }
    
    // RISK CHECK 2: Maximum Drawdown Limit
    // If we lost more than X% total, close positions and STOP monitoring
    if (Math.abs(totalDrawdownPercent) >= riskParams.maxDrawdownLimit) {
      await saveAlert(
        accountId,
        accountName,
        'critical',
        `🚨 MAXIMUM DRAWDOWN LIMIT REACHED: ${totalDrawdownPercent.toFixed(2)}%`,
        { limit: riskParams.maxDrawdownLimit, actual: totalDrawdownPercent }
      );
      
      console.log(`🔴 [${accountName}] EMERGENCY SHUTDOWN - Max drawdown exceeded`);
      await closeAllPositions(accountState.exchange, accountName);
      
      // Deactivate account in database
      accountDoc.isActive = false;
      await accountDoc.save();
      
      await saveAlert(accountId, accountName, 'critical', '⛔ ACCOUNT STOPPED - Maximum drawdown reached');
      
      // Mark account as inactive in our state
      accountState.isActive = false;
    }
    
    // RISK CHECK 3: Too Many Open Positions
    // Warn if too many positions are open
    if (openPositionsCount > riskParams.maxOpenTrades) {
      await saveAlert(
        accountId,
        accountName,
        'warning',
        `⚠️ Too many open positions: ${openPositionsCount}/${riskParams.maxOpenTrades}`
      );
    }
    
    // RISK CHECK 4: Leverage Too High
    // Check each position for excessive leverage
    for (const position of positions) {
      const leverage = parseFloat(position.leverage || 0);
      if (leverage > riskParams.maxLeverage) {
        await saveAlert(
          accountId,
          accountName,
          'warning',
          `⚠️ Position ${position.symbol} exceeds max leverage: ${leverage}x`,
          { symbol: position.symbol, leverage: leverage, limit: riskParams.maxLeverage }
        );
      }
    }
    
  } catch (error) {
    console.error(`❌ [${accountName}] Error during monitoring:`, error.message);
  }
}

// ============================================================================
// FUNCTION: Initialize Account Monitoring
// ============================================================================
// Set up an account for monitoring (get initial balance, etc.)
async function initializeAccount(accountDoc) {
  const accountId = accountDoc._id;
  const accountName = accountDoc.name;
  
  try {
    // Create exchange client
    const exchange = createExchangeClient(accountDoc);
    if (!exchange) {
      throw new Error('Failed to create exchange client');
    }
    
    // Get initial balance
    const initialBalance = await getAccountBalance(exchange, accountName);
    
    // If no initial balance stored in database, store it now
    if (!accountDoc.initialBalance) {
      accountDoc.initialBalance = initialBalance;
      await accountDoc.save();
    }
    
    console.log(`💰 [${accountName}] Initial Balance: $${initialBalance.toFixed(2)}`);
    
    // Create state object for this account
    const accountState = {
      accountDoc: accountDoc,
      exchange: exchange,
      isActive: true,
      initialBalance: accountDoc.initialBalance,
      dailyStartBalance: initialBalance,
      currentBalance: initialBalance,
      lastDayReset: new Date().toDateString(),
      lastDayResetOld: new Date().toDateString(),
      metrics: null,
    };
    
    return accountState;
  } catch (error) {
    console.error(`❌ [${accountName}] Initialization failed:`, error.message);
    await saveAlert(accountId, accountName, 'critical', 'Account initialization failed', { error: error.message });
    return null;
  }
}

// ============================================================================
// FUNCTION: Main Monitoring Loop
// ============================================================================
// This is the main loop that runs forever, checking all accounts
async function startMonitoring() {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║     MULTI-EXCHANGE TRADING RISK MANAGEMENT BOT            ║
║     24/7 Monitoring - Powered by CCXT                     ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
  `);
  
  // Step 1: Connect to database
  const connected = await connectToDatabase();
  if (!connected) {
    console.log('❌ Cannot start without database connection');
    return;
  }
  
  // Step 2: Load accounts from database
  const accounts = await loadActiveAccounts();
  if (accounts.length === 0) {
    console.log('⚠️  No active accounts found. Waiting for accounts to be added...');
    // In production, you could poll database every minute for new accounts
    return;
  }
  
  // Step 3: Initialize each account
  const accountStates = [];
  for (const accountDoc of accounts) {
    const state = await initializeAccount(accountDoc);
    if (state) {
      accountStates.push(state);
    }
  }
  
  if (accountStates.length === 0) {
    console.log('❌ No accounts successfully initialized');
    return;
  }
  
  console.log(`\n✅ Initialized ${accountStates.length} account(s)\n`);
  console.log('🚀 Starting 24/7 monitoring...\n');
  
  // Step 4: Main monitoring loop (runs forever)
  let isRunning = true;
  
  while (isRunning) {
    try {
      // Monitor all active accounts
      for (const accountState of accountStates) {
        // Skip if account was deactivated
        if (!accountState.isActive) continue;
        
        // Monitor this account
        await monitorAccount(accountState.accountDoc, accountState);
      }
      
      // Wait before next check (5 seconds by default)
      await sleep(CONFIG.CHECK_INTERVAL);
      
    } catch (error) {
      console.error('❌ Error in monitoring loop:', error.message);
      // Wait 5 seconds before retrying
      await sleep(5000);
    }
  }
}

// ============================================================================
// HELPER FUNCTION: Sleep/Wait
// ============================================================================
// Pause execution for X milliseconds
function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// ============================================================================
// HANDLE GRACEFUL SHUTDOWN
// ============================================================================
// When user presses Ctrl+C, shut down gracefully
process.on('SIGINT', async () => {
  console.log('\n\n🛑 Received shutdown signal...');
  console.log('🔌 Closing database connection...');
  await mongoose.connection.close();
  console.log('👋 Bot stopped gracefully');
  process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', async (error) => {
  console.error('❌ Uncaught Exception:', error);
  await mongoose.connection.close();
  process.exit(1);
});

// ============================================================================
// START THE BOT
// ============================================================================
// This runs when you execute: node bot.js
startMonitoring().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});

// ============================================================================
// INSTALLATION INSTRUCTIONS
// ============================================================================
/*

📦 INSTALLATION:

1. Install Node.js packages:
   npm install ccxt mongoose dotenv

2. Create .env file with:
   MONGODB_URI=mongodb://localhost:27017/trading_risk
   ENCRYPTION_SECRET=your-secret-key-here

3. Make sure MongoDB is running

4. Run the bot:
   node bot.js

5. The bot will:
   ✓ Connect to MongoDB
   ✓ Load all active accounts
   ✓ Monitor them every 5 seconds
   ✓ Close positions if risk limits exceeded
   ✓ Save all metrics to database
   ✓ Run 24/7 until you stop it

6. To stop the bot:
   Press Ctrl+C

7. To run bot in background (Linux/Mac):
   npm install -g pm2
   pm2 start bot.js --name trading-bot
   pm2 logs trading-bot

✨ The bot runs independently from the web dashboard!
   Users can add/edit accounts in dashboard, and bot will use them.

*/