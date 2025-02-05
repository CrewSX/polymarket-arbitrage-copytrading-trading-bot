use std::sync::Arc;

use mev_bot_solana::bot::solana_mev_bot::SolanaMevBot;
use mev_bot_solana::config::Config;
use mev_bot_solana::dex::dex_manager::DexManager;
use mev_bot_solana::monitoring::dashboard::Dashboard;
use mev_bot_solana::monitoring::metrics::Metrics;
use mev_bot_solana::strategies::copy_trade_strategy::CopyTradeStrategy;
use mev_bot_solana::strategies::sniping_strategy::SnipingStrategy;
use mev_bot_solana::utils::config_parser::parse_config;
use solana_client::rpc_client::RpcClient;
use solana_sdk::signature::read_keypair_file;

#[tokio::main]
async fn main() {
    /**
     * If you need help, contact here: https://t.me/shiny0103
     */
}