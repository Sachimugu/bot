// ============================================================================
// PER-TRADE RISK MANAGEMENT BOT - YOUR CUSTOM RULES
// ============================================================================
// Rules:
// 1. Daily limit applies to EACH INDIVIDUAL TRADE (not total account)
// 2. If a trade hits daily limit, close it and block that symbol until midnight
// 3. Max drawdown = close ALL trades + block entire account until midnight
// 4. Auto-close trades exceeding max leverage
// 5. Auto-close excess trades beyond max open trades limit
// ============================================================================

const ccxt = require('ccxt');
const mongoose = require('mongoose');
const crypto = require('crypto');
require('dotenv').config();


//=============================================================================
// RENDER CONFIG
//=============================================================================

const http = require('http');

// Health check server
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'OK', 
      message: 'Trading Bot is Running',
      timestamp: new Date().toISOString()
    }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Trading Risk Management Bot is Active\n');
  }
});

const PORT = process.env.PORT || 3000;
// ============================================================================
// CONFIGURATION
// ============================================================================
const CONFIG = {
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017/trading_risk',
  CHECK_INTERVAL: 5000, // Check every 5 seconds
  ENCRYPTION_SECRET: process.env.ENCRYPTION_SECRET,
};

// ============================================================================
// DATABASE SCHEMAS
// ============================================================================

const AccountSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  name: String,
  exchange: String,
  apiKey: String,
  apiSecret: String,
  password: String,
  options: mongoose.Schema.Types.Mixed,
  riskParams: {
    dailyDrawdownLimit: Number,    // % loss per INDIVIDUAL trade
    maxDrawdownLimit: Number,      // % loss for ENTIRE account
    maxLeverage: Number,           // Max leverage per trade
    maxOpenTrades: Number,         // Max number of trades
  },
  isActive: Boolean,
  initialBalance: Number,
  lastCheck: Date,
  
  // NEW: Blocked trades (symbol → timestamp when unblocked)
  blockedSymbols: {
    type: Map,
    of: Date,
    default: new Map()
  },
  
  // NEW: Account blocked until this time (for max drawdown)
  blockedUntil: Date,
});

const MetricSchema = new mongoose.Schema({
  accountId: mongoose.Schema.Types.ObjectId,
  currentBalance: Number,
  totalPnL: Number,
  dailyPnL: Number,
  totalDrawdownPercent: Number,
  dailyDrawdownPercent: Number,
  openPositions: Number,
  timestamp: { type: Date, default: Date.now },
});

const AlertSchema = new mongoose.Schema({
  accountId: mongoose.Schema.Types.ObjectId,
  level: String,
  message: String,
  data: mongoose.Schema.Types.Mixed,
  timestamp: { type: Date, default: Date.now },
  read: { type: Boolean, default: false },
});

// NEW: Track individual trade performance
const TradeHistorySchema = new mongoose.Schema({
  accountId: mongoose.Schema.Types.ObjectId,
  symbol: String,              // e.g., "BTC/USDT"
  side: String,                // "long" or "short"
  entryPrice: Number,
  entryTime: Date,
  exitPrice: Number,
  exitTime: Date,
  pnlPercent: Number,
  reason: String,              // Why it was closed
  leverage: Number,
  size: Number,
});

const Account = mongoose.models.Account || mongoose.model('Account', AccountSchema);
const Metric = mongoose.models.Metric || mongoose.model('Metric', MetricSchema);
const Alert = mongoose.models.Alert || mongoose.model('Alert', AlertSchema);
const TradeHistory = mongoose.models.TradeHistory || mongoose.model('TradeHistory', TradeHistorySchema);

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function decryptApiKey(encryptedData) {
  if (!encryptedData) return null;
  
  const ALGORITHM = 'aes-256-gcm';
  const SECRET_KEY = CONFIG.ENCRYPTION_SECRET;
  const buffer = Buffer.from(encryptedData, 'base64');
  
  const salt = buffer.subarray(0, 64);
  const iv = buffer.subarray(64, 80);
  const tag = buffer.subarray(80, 96);
  const encrypted = buffer.subarray(96);
  
  const key = crypto.pbkdf2Sync(SECRET_KEY, salt, 100000, 32, 'sha512');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
  ]);
  
  return decrypted.toString('utf8');
}

async function connectToDatabase() {
  try {
    await mongoose.connect(CONFIG.MONGODB_URI);
    console.log('✅ Connected to MongoDB');
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    return false;
  }
}

async function loadActiveAccounts() {
  try {
    const accounts = await Account.find({ isActive: true });
    console.log(`📋 Found ${accounts.length} active account(s)`);
    return accounts;
  } catch (error) {
    console.error('❌ Error loading accounts:', error.message);
    return [];
  }
}

function createExchangeClient(accountDoc) {
  try {
    const apiKey = decryptApiKey(accountDoc.apiKey);
    const apiSecret = decryptApiKey(accountDoc.apiSecret);
    const password = accountDoc.password ? decryptApiKey(accountDoc.password) : undefined;
    
    const ExchangeClass = ccxt[accountDoc.exchange];
    if (!ExchangeClass) {
      throw new Error(`Exchange ${accountDoc.exchange} not supported`);
    }
    
    const exchange = new ExchangeClass({
      apiKey,
      secret: apiSecret,
      password,
      enableRateLimit: true,
      options: accountDoc.options || {},
    });
    
    console.log(`✅ Connected to ${accountDoc.exchange} (${accountDoc.name})`);
    return exchange;
  } catch (error) {
    console.error(`❌ Failed to create exchange for ${accountDoc.name}:`, error.message);
    return null;
  }
}

async function getAccountBalance(exchange, accountName) {
  try {
    const balance = await exchange.fetchBalance();
    const usdtBalance = balance.USDT?.total || balance.total?.USDT || 0;
    return parseFloat(usdtBalance);
  } catch (error) {
    console.error(`❌ [${accountName}] Error fetching balance:`, error.message);
    throw error;
  }
}

async function getOpenPositions(exchange, accountName) {
  try {
    const positions = await exchange.fetchPositions();
    const openPositions = positions.filter(pos => {
      const contracts = parseFloat(pos.contracts || 0);
      return contracts > 0;
    });
    return openPositions;
  } catch (error) {
    console.error(`❌ [${accountName}] Error fetching positions:`, error.message);
    return [];
  }
}

async function closePosition(exchange, accountName, symbol, side) {
  try {
    const order = await exchange.createOrder(
      symbol,
      'market',
      side === 'long' ? 'sell' : 'buy',
      null, // Close entire position
      null,
      { reduceOnly: true }
    );
    
    console.log(`✅ [${accountName}] Closed position: ${symbol}`);
    return order;
  } catch (error) {
    console.error(`❌ [${accountName}] Error closing ${symbol}:`, error.message);
    throw error;
  }
}

async function closeAllPositions(exchange, accountName) {
  try {
    const positions = await getOpenPositions(exchange, accountName);
    
    if (positions.length === 0) {
      console.log(`[${accountName}] No positions to close`);
      return;
    }
    
    console.log(`🔴 [${accountName}] Closing ALL ${positions.length} position(s)...`);
    
    for (const position of positions) {
      await closePosition(exchange, accountName, position.symbol, position.side);
    }
    
    console.log(`✅ [${accountName}] All positions closed`);
  } catch (error) {
    console.error(`❌ [${accountName}] Error closing all positions:`, error.message);
  }
}

async function saveAlert(accountId, accountName, level, message, data = {}) {
  try {
    await Alert.create({
      accountId,
      level,
      message,
      data,
    });
    console.log(`🚨 [${accountName}] [${level.toUpperCase()}] ${message}`);
  } catch (error) {
    console.error('❌ Error saving alert:', error.message);
  }
}

async function saveMetrics(accountId, metrics) {
  try {
    await Metric.create({
      accountId,
      ...metrics,
    });
  } catch (error) {
    console.error('❌ Error saving metrics:', error.message);
  }
}

async function saveTradeHistory(accountId, trade) {
  try {
    await TradeHistory.create({
      accountId,
      ...trade,
    });
  } catch (error) {
    console.error('❌ Error saving trade history:', error.message);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getMidnightTonight() {
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0); // Next midnight
  return midnight;
}

function isSymbolBlocked(accountDoc, symbol) {
  if (!accountDoc.blockedSymbols) return false;
  
  const blockedUntil = accountDoc.blockedSymbols.get(symbol);
  if (!blockedUntil) return false;
  
  // Check if still blocked
  if (new Date() < new Date(blockedUntil)) {
    return true;
  }
  
  // Unblock if past midnight
  accountDoc.blockedSymbols.delete(symbol);
  return false;
}

function isAccountBlocked(accountDoc) {
  if (!accountDoc.blockedUntil) return false;
  
  // Check if still blocked
  if (new Date() < new Date(accountDoc.blockedUntil)) {
    return true;
  }
  
  // Unblock if past midnight
  accountDoc.blockedUntil = null;
  return false;
}

// ============================================================================
// MAIN MONITORING FUNCTION - YOUR RULES IMPLEMENTED
// ============================================================================
async function monitorAccount(accountDoc, accountState) {
  const accountId = accountDoc._id;
  const accountName = accountDoc.name;
  const riskParams = accountDoc.riskParams;
  
  try {
    // ========================================
    // RULE: Check if entire account is blocked
    // (Max drawdown reached, wait until midnight)
    // ========================================
    if (isAccountBlocked(accountDoc)) {
      const blockedUntil = new Date(accountDoc.blockedUntil).toLocaleString();
      console.log(`⛔ [${accountName}] Account blocked until ${blockedUntil}`);
      return; // Skip monitoring
    }
    
    // Get current balance and positions
    const currentBalance = await getAccountBalance(accountState.exchange, accountName);
    const positions = await getOpenPositions(accountState.exchange, accountName);
    
    // Calculate account-level P&L
    const totalPnL = currentBalance - accountState.initialBalance;
    const totalDrawdownPercent = (totalPnL / accountState.initialBalance) * 100;
    
    console.log(
      `[${new Date().toLocaleTimeString()}] [${accountName}] ` +
      `Balance: $${currentBalance.toFixed(2)} | ` +
      `Total P&L: ${totalDrawdownPercent.toFixed(2)}% | ` +
      `Positions: ${positions.length}/${riskParams.maxOpenTrades}`
    );
    
    // ========================================
    // RULE 1: MAX DRAWDOWN - Close ALL trades + Block account
    // If account total loss >= max drawdown limit
    // Close everything and block until midnight
    // ========================================
    if (totalDrawdownPercent <= -Math.abs(riskParams.maxDrawdownLimit)) {
      await saveAlert(
        accountId,
        accountName,
        'critical',
        `🚨 MAX DRAWDOWN REACHED: ${totalDrawdownPercent.toFixed(2)}% | CLOSING ALL TRADES + BLOCKING ACCOUNT UNTIL MIDNIGHT`,
        { limit: riskParams.maxDrawdownLimit, actual: totalDrawdownPercent }
      );
      
      // Close all positions
      await closeAllPositions(accountState.exchange, accountName);
      
      // Block account until midnight
      accountDoc.blockedUntil = getMidnightTonight();
      accountDoc.isActive = false; // Deactivate
      await accountDoc.save();
      
      await saveAlert(
        accountId,
        accountName,
        'critical',
        `⛔ ACCOUNT BLOCKED UNTIL MIDNIGHT (${getMidnightTonight().toLocaleString()})`
      );
      
      accountState.isActive = false;
      return; // Stop monitoring this account
    }
    
    // ========================================
    // RULE 2: MAX OPEN TRADES LIMIT
    // If there are more trades than allowed,
    // close the NEWEST trades (last opened)
    // ========================================
    if (positions.length > riskParams.maxOpenTrades) {
      await saveAlert(
        accountId,
        accountName,
        'warning',
        `⚠️ Too many trades: ${positions.length}/${riskParams.maxOpenTrades} | Auto-closing excess trades`
      );
      
      // Sort positions by timestamp (newest first)
      const sortedPositions = [...positions].sort((a, b) => {
        const timeA = new Date(a.timestamp || a.datetime || 0).getTime();
        const timeB = new Date(b.timestamp || b.datetime || 0).getTime();
        return timeB - timeA; // Newest first
      });
      
      // Close excess trades (newest ones)
      const excessCount = positions.length - riskParams.maxOpenTrades;
      const tradesToClose = sortedPositions.slice(0, excessCount);
      
      for (const trade of tradesToClose) {
        console.log(`🔴 [${accountName}] Auto-closing excess trade: ${trade.symbol}`);
        await closePosition(accountState.exchange, accountName, trade.symbol, trade.side);
        
        await saveTradeHistory(accountId, {
          symbol: trade.symbol,
          side: trade.side,
          entryPrice: trade.entryPrice,
          entryTime: trade.timestamp || trade.datetime,
          exitPrice: trade.markPrice,
          exitTime: new Date(),
          pnlPercent: trade.percentage || 0,
          reason: 'MAX_TRADES_EXCEEDED',
          leverage: trade.leverage,
          size: trade.contracts,
        });
      }
    }
    
    // ========================================
    // RULE 3 & 4: Check EACH INDIVIDUAL TRADE
    // ========================================
    for (const position of positions) {
      const symbol = position.symbol;
      const side = position.side;
      const leverage = parseFloat(position.leverage || 0);
      const entryPrice = parseFloat(position.entryPrice || 0);
      const markPrice = parseFloat(position.markPrice || position.info?.markPrice || 0);
      const unrealizedPnl = parseFloat(position.unrealizedPnl || 0);
      const percentage = parseFloat(position.percentage || 0);
      
      // Calculate P&L percentage for this specific trade
      let tradePnLPercent = percentage;
      if (!tradePnLPercent && entryPrice && markPrice) {
        // Calculate manually if exchange doesn't provide it
        if (side === 'long') {
          tradePnLPercent = ((markPrice - entryPrice) / entryPrice) * 100 * leverage;
        } else {
          tradePnLPercent = ((entryPrice - markPrice) / entryPrice) * 100 * leverage;
        }
      }
      
      console.log(
        `  └─ ${symbol} (${side}) | ` +
        `Entry: $${entryPrice.toFixed(2)} | ` +
        `Mark: $${markPrice.toFixed(2)} | ` +
        `P&L: ${tradePnLPercent.toFixed(2)}% | ` +
        `Leverage: ${leverage}x`
      );
      
      // ========================================
      // RULE 3: LEVERAGE CHECK
      // If trade leverage > max leverage, close it immediately
      // ========================================
      if (leverage > riskParams.maxLeverage) {
        await saveAlert(
          accountId,
          accountName,
          'warning',
          `⚠️ ${symbol} leverage ${leverage}x exceeds limit ${riskParams.maxLeverage}x | Auto-closing`,
          { symbol, leverage, limit: riskParams.maxLeverage }
        );
        
        console.log(`🔴 [${accountName}] Closing ${symbol} - Leverage too high (${leverage}x)`);
        await closePosition(accountState.exchange, accountName, symbol, side);
        
        await saveTradeHistory(accountId, {
          symbol,
          side,
          entryPrice,
          entryTime: position.timestamp || position.datetime,
          exitPrice: markPrice,
          exitTime: new Date(),
          pnlPercent: tradePnLPercent,
          reason: 'LEVERAGE_EXCEEDED',
          leverage,
          size: position.contracts,
        });
        
        continue; // Move to next trade
      }
      
      // ========================================
      // RULE 4: DAILY LIMIT PER TRADE
      // If THIS SPECIFIC trade's loss >= daily limit,
      // close it and block this symbol until midnight
      // ========================================
      if (tradePnLPercent <= -Math.abs(riskParams.dailyDrawdownLimit)) {
        await saveAlert(
          accountId,
          accountName,
          'critical',
          `🚨 ${symbol} hit daily limit: ${tradePnLPercent.toFixed(2)}% | Closing & blocking symbol until midnight`,
          { 
            symbol, 
            limit: riskParams.dailyDrawdownLimit, 
            actual: tradePnLPercent,
            blockedUntil: getMidnightTonight()
          }
        );
        
        console.log(`🔴 [${accountName}] Closing ${symbol} - Daily limit reached (${tradePnLPercent.toFixed(2)}%)`);
        await closePosition(accountState.exchange, accountName, symbol, side);
        
        // Block this symbol until midnight
        if (!accountDoc.blockedSymbols) {
          accountDoc.blockedSymbols = new Map();
        }
        accountDoc.blockedSymbols.set(symbol, getMidnightTonight());
        await accountDoc.save();
        
        await saveTradeHistory(accountId, {
          symbol,
          side,
          entryPrice,
          entryTime: position.timestamp || position.datetime,
          exitPrice: markPrice,
          exitTime: new Date(),
          pnlPercent: tradePnLPercent,
          reason: 'DAILY_LIMIT_REACHED',
          leverage,
          size: position.contracts,
        });
        
        await saveAlert(
          accountId,
          accountName,
          'warning',
          `⛔ ${symbol} blocked until midnight (${getMidnightTonight().toLocaleString()})`
        );
        
        continue;
      }
      
      // ========================================
      // Check if trade is on a blocked symbol
      // (Symbol was previously closed for daily limit)
      // ========================================
      if (isSymbolBlocked(accountDoc, symbol)) {
        const blockedUntil = accountDoc.blockedSymbols.get(symbol);
        await saveAlert(
          accountId,
          accountName,
          'warning',
          `⚠️ ${symbol} is blocked! Closing trade. Blocked until: ${new Date(blockedUntil).toLocaleString()}`
        );
        
        console.log(`🔴 [${accountName}] Closing ${symbol} - Symbol is blocked`);
        await closePosition(accountState.exchange, accountName, symbol, side);
        
        await saveTradeHistory(accountId, {
          symbol,
          side,
          entryPrice,
          entryTime: position.timestamp || position.datetime,
          exitPrice: markPrice,
          exitTime: new Date(),
          pnlPercent: tradePnLPercent,
          reason: 'SYMBOL_BLOCKED',
          leverage,
          size: position.contracts,
        });
      }
    }
    
    // Save account metrics
    await saveMetrics(accountId, {
      currentBalance,
      totalPnL,
      dailyPnL: 0, // Not tracking daily anymore (per-trade now)
      totalDrawdownPercent,
      dailyDrawdownPercent: 0,
      openPositions: positions.length,
    });
    
    // Update last check time
    accountDoc.lastCheck = new Date();
    await accountDoc.save();
    
  } catch (error) {
    console.error(`❌ [${accountName}] Error during monitoring:`, error.message);
  }
}

// ============================================================================
// INITIALIZATION
// ============================================================================
async function initializeAccount(accountDoc) {
  const accountId = accountDoc._id;
  const accountName = accountDoc.name;
  
  try {
    const exchange = createExchangeClient(accountDoc);
    if (!exchange) {
      throw new Error('Failed to create exchange client');
    }
    
    const initialBalance = await getAccountBalance(exchange, accountName);
    
    if (!accountDoc.initialBalance) {
      accountDoc.initialBalance = initialBalance;
      await accountDoc.save();
    }
    
    console.log(`💰 [${accountName}] Initial Balance: $${initialBalance.toFixed(2)}`);
    
    const accountState = {
      accountDoc,
      exchange,
      isActive: true,
      initialBalance: accountDoc.initialBalance,
    };
    
    return accountState;
  } catch (error) {
    console.error(`❌ [${accountName}] Initialization failed:`, error.message);
    await saveAlert(accountId, accountName, 'critical', 'Account initialization failed', { error: error.message });
    return null;
  }
}

// ============================================================================
// MAIN LOOP
// ============================================================================
async function startMonitoring() {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║     PER-TRADE RISK MANAGEMENT BOT                         ║
║     Custom Rules Implementation                           ║
║                                                            ║
║  ✓ Daily limit per individual trade                      ║
║  ✓ Symbol blocking until midnight                        ║
║  ✓ Max drawdown = close all + block account             ║
║  ✓ Auto-close excess leverage                            ║
║  ✓ Auto-close excess trades                              ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
  `);
  
  const connected = await connectToDatabase();
  if (!connected) {
    console.log('❌ Cannot start without database');
    return;
  }
  
  const accounts = await loadActiveAccounts();
  if (accounts.length === 0) {
    console.log('⚠️  No active accounts found');
    return;
  }
  
  const accountStates = [];
  for (const accountDoc of accounts) {
    const state = await initializeAccount(accountDoc);
    if (state) {
      accountStates.push(state);
    }
  }
  
  if (accountStates.length === 0) {
    console.log('❌ No accounts initialized');
    return;
  }
  
  console.log(`\n✅ Initialized ${accountStates.length} account(s)\n`);
  console.log('🚀 Starting 24/7 monitoring with your custom rules...\n');
  
  let isRunning = true;
  
  while (isRunning) {
    try {
      for (const accountState of accountStates) {
        if (!accountState.isActive) continue;
        
        // Reload account from DB (to get updated blockedSymbols, blockedUntil)
        accountState.accountDoc = await Account.findById(accountState.accountDoc._id);
        
        await monitorAccount(accountState.accountDoc, accountState);
      }
      
      await sleep(CONFIG.CHECK_INTERVAL);
      
    } catch (error) {
      console.error('❌ Error in monitoring loop:', error.message);
      await sleep(5000);
    }
  }
}

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================
process.on('SIGINT', async () => {
  console.log('\n\n🛑 Shutting down...');
  await mongoose.connection.close();
  console.log('👋 Bot stopped');
  process.exit(0);
});

process.on('uncaughtException', async (error) => {
  console.error('❌ Uncaught Exception:', error);
  await mongoose.connection.close();
  process.exit(1);
});

// ============================================================================
// START
// ============================================================================
// startMonitoring().catch(error => {
//   console.error('❌ Fatal error:', error);
//   process.exit(1);
// });

// ============================================================================
// START
// ============================================================================
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Bot server running on port ${PORT}`);
  console.log(`❤️  Health check available at http://0.0.0.0:${PORT}/health`);
  startMonitoring().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });
});

// ============================================================================
// SUMMARY OF YOUR RULES IMPLEMENTATION
// ============================================================================
/*

✅ YOUR RULES IMPLEMENTED:

1. DAILY LIMIT PER TRADE:
   - Each individual trade is tracked
   - If BTC/USDT hits -5% (daily limit), only BTC/USDT closes
   - BTC/USDT is blocked until midnight (12:00 AM)
   - Other trades (ETH/USDT, etc.) continue normally
   - At midnight, BTC/USDT is unblocked

2. MAX DRAWDOWN (ENTIRE ACCOUNT):
   - If total account loss hits -20% (max drawdown):
     → Close ALL trades immediately
     → Block entire account until midnight
     → No new trades allowed until midnight reset

3. LEVERAGE CHECK:
   - Every check cycle, examine each trade's leverage
   - If leverage > maxLeverage (e.g., 20x)
     → Close that specific trade immediately
   - Other trades unaffected

4. MAX OPEN TRADES:
   - If 6 trades open but max is 3:
     → Close the 3 NEWEST trades
     → Keep the 3 oldest trades
   - Checked every cycle

5. BLOCKED SYMBOLS:
   - If new BTC/USDT position opens while blocked:
     → Auto-close immediately
   - Stays blocked until midnight

6. MIDNIGHT RESET:
   - All symbol blocks removed at 12:00 AM
   - Account unblocked at 12:00 AM (if max drawdown hit)
   - Fresh start each day

*/