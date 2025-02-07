use crate::dex::dex_manager::DexManager;
use crate::error::Result;
use crate::models::copy_trade_opportunity::CopyTradeOpportunity;
use crate::models::order::Order;
use crate::models::market::Market;

use solana_client::rpc_client::RpcClient;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Keypair;

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};
use tracing::{info, error}; // Use `tracing` for better logging

/// Represents a Copy Trading Strategy
pub struct CopyTradeStrategy {
    pub rpc_client: Arc<RpcClient>,
    pub dex_manager: Arc<Mutex<DexManager>>,
    pub tracked_traders: Vec<Pubkey>,
    pub trade_threshold: f64,
    pub max_trade_amount: f64,
    pub polling_interval: Duration, // Add configurable polling
}

impl CopyTradeStrategy {
    /// Create a new instance of the CopyTradeStrategy
    pub fn new(
        rpc_client: Arc<RpcClient>,
        dex_manager: Arc<Mutex<DexManager>>,
        tracked_traders: Vec<Pubkey>,
        trade_threshold: f64,
        max_trade_amount: f64,
        polling_interval: Duration,
    ) -> Self {
        CopyTradeStrategy {
            rpc_client,
            dex_manager,
            tracked_traders,
            trade_threshold,
            max_trade_amount,
            polling_interval,
        }
    }

    /// Run the strategy (main execution loop)
    pub async fn run(&self) -> Result<()> {
        info!("CopyTradeStrategy starting...");
        loop {
            match timeout(self.polling_interval, self.check_and_execute()).await {
                Ok(Ok(())) => info!("Completed one iteration of checking."),
                Ok(Err(e)) => error!("Error during execution: {:?}", e),
                Err(_) => error!("Polling interval timeout exceeded."),
            }

            // Wait for the next polling cycle
            tokio::time::sleep(self.polling_interval).await;
        }
    }

    async fn check_and_execute(&self) -> Result<()> {
        // Find trading opportunities
        let opportunities = self.find_opportunities().await?;
        if opportunities.is_empty() {
            info!("No trading opportunities found");
            return Ok(());
        }

        // Execute trades for all found opportunities
        for opportunity in opportunities {
            if let Err(e) = self.execute_copy_trade(&opportunity).await {
                error!("Failed to execute copy trade: {:?}", e);
            }
        }

        Ok(())
    }

    /// Find trading opportunities based on tracked traders
    async fn find_opportunities(&self) -> Result<Vec<CopyTradeOpportunity>> {
        let mut opportunities = Vec::new();
        for trader in &self.tracked_traders {
            let trades = match self.get_recent_trades(trader).await {
                Ok(trades) => trades,
                Err(e) => {
                    error!("Failed to fetch trades for trader {:?}: {:?}", trader, e);
                    continue;
                }
            };

            for trade in trades {
                // Filter trade opportunities based on thresholds
                if trade.quantity >= self.trade_threshold && trade.quantity <= self.max_trade_amount
                {
                    let market = self
                        .dex_manager
                        .lock()
                        .await
                        .get_market(&trade.market)
                        .await
                        .unwrap_or_else(|_| continue); // Skip invalid markets

                    opportunities.push(CopyTradeOpportunity {
                        trader: *trader,
                        market,
                        trade,
                    });
                }
            }
        }

        Ok(opportunities)
    }

    /// Fetch recent trades for a given trader
    async fn get_recent_trades(&self, trader: &Pubkey) -> Result<Vec<Order>> {
        let signature_infos = self.rpc_client.get_signatures_for_address(trader)?;
        // Apply timeout to fetching individual trades
        let fetch_timeout = Duration::from_secs(5);
        let mut trades = Vec::new();

        for signature_info in signature_infos {
            if let Some(signature) = signature_info.signature {
                let transaction = match timeout(fetch_timeout, self.rpc_client.get_transaction(&signature)).await {
                    Ok(Ok(t)) => t,
                    Ok(Err(e)) => {
                        error!("Failed to fetch transaction {:?}: {:?}", signature, e);
                        continue;
                    }
                    Err(_) => {
                        error!("Fetching transaction {:?} timed out", signature);
                        continue;
                    }
                };

                if let Some(transaction) = transaction {
                    for instruction in transaction.transaction.message.instructions {
                        if let Some(dex_instruction) = DexInstruction::unpack(instruction) {
                            match dex_instruction {
                                DexInstruction::NewOrder { .. } => {
                                    if let Ok(order) =
                                        self.parse_order(&transaction, &instruction)
                                    {
                                        trades.push(order);
                                    }
                                }
                                _ => {} // Ignore non-NewOrder instructions
                            }
                        }
                    }
                }
            }
        }

        Ok(trades)
    }

    /// Parse an order from a transaction instruction
    fn parse_order(
        &self,
        transaction: &TransactionInfo,
        instruction: &CompiledInstruction,
    ) -> Result<Order> {
        let market_address = instruction.accounts[0];
        let market = self
            .dex_manager
            .lock()
            .await
            .get_market(&market_address)
            .await?; // Leverage fine-grained locking

        let side = OrderSide::from_u8(instruction.data[0])?;
        let order_type = OrderType::from_u8(instruction.data[1])?;
        
        // Properly handle errors when parsing price/quantity
        let price = f64::from_le_bytes(instruction.data[2..10].try_into().map_err(|_| anyhow!("Invalid price data"))?)?;
        let quantity = f64::from_le_bytes(instruction.data[10..18].try_into().map_err(|_| anyhow!("Invalid quantity data"))?)?;

        Ok(Order {
            id: transaction.transaction.signatures[0].to_string(),
            market,
            side,
            order_type,
            price,
            quantity,
            status: OrderStatus::Filled,
        })
    }

    /// Execute a trade copy based on an opportunity
    async fn execute_copy_trade(&self, opportunity: &CopyTradeOpportunity) -> Result<()> {
        self.dex_manager
            .lock()
            .await
            .place_order(
                &opportunity.market,
                opportunity.trade.order_type,
                opportunity.trade.side,
                opportunity.trade.price,
                opportunity.trade.quantity,
            )
            .await
            .map(|order| {
                info!("Copy trade order placed: {:?}", order);
            })
            .map_err(|e| {
                error!("Failed to place order: {:?}", e);
                e
            })
    }
}
