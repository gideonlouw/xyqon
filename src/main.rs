use chrono::prelude::*;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const INITIAL_DIFFICULTY: usize = 4;
const MIN_DIFFICULTY: usize = 1;
const TARGET_BLOCK_TIME_SECONDS: i64 = 30;
const GENESIS_TIMESTAMP: i64 = 1_700_000_000;
const INITIAL_MINING_REWARD: f64 = 10.0;
const HALVING_INTERVAL: u64 = 100_000;
const MAX_COIN_SUPPLY: f64 = 67_000_000.0;
const BALANCE_EPSILON: f64 = 0.000_000_01;

#[derive(Serialize, Deserialize, Debug, Clone)]
struct Transaction {
    sender: String,
    recipient: String,
    amount: f64,
    sender_public_key: String,
    signature: String,
}

impl Transaction {
    fn new(sender: &str, recipient: &str, amount: f64, signing_key: &SigningKey) -> Self {
        let sender_public_key = bytes_to_hex(signing_key.verifying_key().as_bytes());
        let payload = Transaction::payload(sender, recipient, amount, &sender_public_key);
        let signature = signing_key.sign(payload.as_bytes());

        Transaction {
            sender: sender.to_string(),
            recipient: recipient.to_string(),
            amount,
            sender_public_key,
            signature: bytes_to_hex(&signature.to_bytes()),
        }
    }

    fn system(sender: &str, recipient: &str, amount: f64) -> Self {
        Transaction {
            sender: sender.to_string(),
            recipient: recipient.to_string(),
            amount,
            sender_public_key: String::new(),
            signature: String::new(),
        }
    }

    fn coinbase(recipient: &str, amount: f64) -> Self {
        Transaction::system("network", recipient, amount)
    }

    fn is_valid_signed_transaction(&self) -> bool {
        if self.sender == "network" {
            return false;
        }

        let Some(public_key_bytes) = hex_to_array::<32>(&self.sender_public_key) else {
            return false;
        };
        let Some(signature_bytes) = hex_to_array::<64>(&self.signature) else {
            return false;
        };

        let Ok(public_key) = VerifyingKey::from_bytes(&public_key_bytes) else {
            return false;
        };

        let signature = Signature::from_bytes(&signature_bytes);
        let payload = Transaction::payload(
            &self.sender,
            &self.recipient,
            self.amount,
            &self.sender_public_key,
        );

        public_key.verify(payload.as_bytes(), &signature).is_ok()
    }

    fn is_valid_genesis_transaction(&self) -> bool {
        self.sender == "network"
            && self.recipient == "genesis"
            && self.amount == 0.0
            && self.sender_public_key.is_empty()
            && self.signature.is_empty()
    }

    fn is_valid_coinbase_reward(&self, expected_reward: f64) -> bool {
        self.sender == "network"
            && !self.recipient.is_empty()
            && amounts_equal(self.amount, expected_reward)
            && self.sender_public_key.is_empty()
            && self.signature.is_empty()
    }

    fn payload(sender: &str, recipient: &str, amount: f64, sender_public_key: &str) -> String {
        format!("{sender}|{recipient}|{amount:.8}|{sender_public_key}")
    }

    fn id(&self) -> String {
        let serialized = serde_json::to_string(self).expect("transaction should serialize");
        let mut hasher = Sha256::new();
        hasher.update(serialized);
        format!("{:x}", hasher.finalize())
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct WalletFile {
    name: String,
    public_key: String,
    private_key: String,
}

impl WalletFile {
    fn generate(name: String) -> Self {
        let signing_key = SigningKey::generate(&mut OsRng);

        WalletFile {
            name,
            public_key: bytes_to_hex(signing_key.verifying_key().as_bytes()),
            private_key: bytes_to_hex(&signing_key.to_bytes()),
        }
    }

    fn load(path: &str) -> Result<Self, String> {
        let contents =
            fs::read_to_string(path).map_err(|error| format!("failed to read wallet: {error}"))?;
        serde_json::from_str(&contents).map_err(|error| format!("failed to parse wallet: {error}"))
    }

    fn save(&self, path: &str) -> Result<(), String> {
        let contents = serde_json::to_string_pretty(self)
            .map_err(|error| format!("failed to serialize wallet: {error}"))?;
        fs::write(path, contents).map_err(|error| format!("failed to save wallet: {error}"))
    }

    fn signing_key(&self) -> Result<SigningKey, String> {
        let Some(private_key_bytes) = hex_to_array::<32>(&self.private_key) else {
            return Err("wallet private key must be a 32-byte hex string".to_string());
        };

        Ok(SigningKey::from_bytes(&private_key_bytes))
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct Block {
    index: u64,
    timestamp: i64,
    difficulty: usize,
    transactions: Vec<Transaction>,
    previous_hash: String,
    hash: String,
    nonce: u64,
}

impl Block {
    fn new(
        index: u64,
        timestamp: i64,
        difficulty: usize,
        transactions: Vec<Transaction>,
        previous_hash: String,
    ) -> Self {
        Block::new_with_timestamp(index, timestamp, difficulty, transactions, previous_hash)
    }

    fn new_with_timestamp(
        index: u64,
        timestamp: i64,
        difficulty: usize,
        transactions: Vec<Transaction>,
        previous_hash: String,
    ) -> Self {
        let mut block = Block {
            index,
            timestamp,
            difficulty,
            transactions,
            previous_hash,
            hash: String::new(),
            nonce: 0,
        };

        block.mine_block(difficulty);
        block
    }

    fn calculate_hash(&self) -> String {
        let transactions =
            serde_json::to_string(&self.transactions).expect("transactions should serialize");
        let input = format!(
            "{}{}{}{}{}{}",
            self.index,
            self.timestamp,
            self.difficulty,
            transactions,
            self.previous_hash,
            self.nonce
        );

        let mut hasher = Sha256::new();
        hasher.update(input);
        format!("{:x}", hasher.finalize())
    }

    fn mine_block(&mut self, difficulty: usize) {
        let target = "0".repeat(difficulty);

        while !self.hash.starts_with(&target) {
            self.nonce += 1;
            self.hash = self.calculate_hash();
        }

        println!("Block mined: {}", self.hash);
    }

    fn is_valid(&self, expected_difficulty: usize, expected_reward: f64) -> bool {
        self.hash == self.calculate_hash()
            && self.difficulty == expected_difficulty
            && self.hash.starts_with(&"0".repeat(expected_difficulty))
            && self.has_valid_transactions(expected_reward)
    }

    fn has_valid_transactions(&self, expected_reward: f64) -> bool {
        if self.index == 0 {
            return self.transactions.len() == 1
                && self.transactions[0].is_valid_genesis_transaction();
        }

        let Some((coinbase, transactions)) = self.transactions.split_first() else {
            return false;
        };

        coinbase.is_valid_coinbase_reward(expected_reward)
            && transactions
                .iter()
                .all(Transaction::is_valid_signed_transaction)
    }

    fn coinbase_amount(&self) -> f64 {
        if self.index == 0 {
            return 0.0;
        }

        self.transactions
            .first()
            .map(|transaction| transaction.amount)
            .unwrap_or(0.0)
    }

    fn normal_transactions(&self) -> &[Transaction] {
        if self.index == 0 || self.transactions.is_empty() {
            return &[];
        }

        &self.transactions[1..]
    }
}

#[derive(Debug, Default)]
struct WalletBalances {
    balances: HashMap<String, f64>,
}

impl WalletBalances {
    fn new() -> Self {
        WalletBalances {
            balances: HashMap::new(),
        }
    }

    fn from_chain(chain: &[Block]) -> Self {
        let mut balances = WalletBalances::new();
        for block in chain.iter().skip(1) {
            balances.apply_block(block);
        }

        balances
    }

    fn apply_block(&mut self, block: &Block) -> bool {
        if let Some(coinbase) = block.transactions.first() {
            self.credit(&coinbase.recipient, coinbase.amount);
        }

        for transaction in block.normal_transactions() {
            if self.apply_signed_transaction(transaction).is_err() {
                return false;
            }
        }

        true
    }

    fn apply_signed_transaction(&mut self, transaction: &Transaction) -> Result<(), String> {
        if transaction.amount <= 0.0 {
            return Err("transaction amount must be positive".to_string());
        }

        let balance = self.balance(&transaction.sender_public_key);
        if balance + BALANCE_EPSILON < transaction.amount {
            return Err(format!(
                "insufficient funds for {}; balance is {}, attempted to spend {}",
                transaction.sender, balance, transaction.amount
            ));
        }

        self.debit(&transaction.sender_public_key, transaction.amount);
        self.credit(&transaction.recipient, transaction.amount);
        Ok(())
    }

    fn balance(&self, public_key: &str) -> f64 {
        *self.balances.get(public_key).unwrap_or(&0.0)
    }

    fn credit(&mut self, public_key: &str, amount: f64) {
        *self.balances.entry(public_key.to_string()).or_insert(0.0) += amount;
    }

    fn debit(&mut self, public_key: &str, amount: f64) {
        *self.balances.entry(public_key.to_string()).or_insert(0.0) -= amount;
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct Blockchain {
    chain: Vec<Block>,
    circulating_supply: f64,
}

impl Blockchain {
    fn new() -> Self {
        let mut blockchain = Blockchain {
            chain: vec![],
            circulating_supply: 0.0,
        };
        blockchain.chain.push(Blockchain::genesis_block());
        blockchain
    }

    fn load_or_new(path: &str) -> Result<Self, String> {
        if !Path::new(path).exists() {
            return Ok(Blockchain::new());
        }

        let contents =
            fs::read_to_string(path).map_err(|error| format!("failed to read chain: {error}"))?;
        let mut blockchain: Blockchain = serde_json::from_str(&contents)
            .map_err(|error| format!("failed to parse chain: {error}"))?;
        blockchain.recalculate_circulating_supply();

        if !blockchain.is_valid() {
            return Err(format!("stored chain is invalid: {path}"));
        }

        Ok(blockchain)
    }

    fn genesis_block() -> Block {
        Block::new_with_timestamp(
            0,
            GENESIS_TIMESTAMP,
            INITIAL_DIFFICULTY,
            vec![Transaction::system("network", "genesis", 0.0)],
            "0".to_string(),
        )
    }

    fn latest_block(&self) -> &Block {
        self.chain.last().unwrap()
    }

    fn add_block(
        &mut self,
        mut transactions: Vec<Transaction>,
        miner_reward_recipient: String,
    ) -> Result<Block, String> {
        if miner_reward_recipient.is_empty() {
            return Err("miner reward recipient cannot be empty".to_string());
        }

        if !transactions
            .iter()
            .all(Transaction::is_valid_signed_transaction)
        {
            return Err("block contains an invalid transaction signature".to_string());
        }

        self.validate_spending(&transactions)?;

        let reward = self.allowed_reward_for_next_block();
        if reward <= 0.0 {
            return Err(format!(
                "max supply of {MAX_COIN_SUPPLY} XYQON has already been reached"
            ));
        }

        transactions.insert(0, Transaction::coinbase(&miner_reward_recipient, reward));

        let prev = self.latest_block();
        let timestamp = Utc::now().timestamp();
        let difficulty = expected_difficulty_for_next_block(prev, timestamp);
        let new_block = Block::new(
            prev.index + 1,
            timestamp,
            difficulty,
            transactions,
            prev.hash.clone(),
        );
        self.chain.push(new_block.clone());
        self.circulating_supply += reward;
        Ok(new_block)
    }

    fn add_received_block(&mut self, block: Block) -> Result<(), String> {
        let previous = self.latest_block();

        if block.index != previous.index + 1 {
            return Err(format!(
                "expected block index {}, got {}",
                previous.index + 1,
                block.index
            ));
        }

        if block.previous_hash != previous.hash {
            return Err("received block does not link to local chain tip".to_string());
        }

        let expected_difficulty = expected_difficulty_for_next_block(previous, block.timestamp);
        let expected_reward = self.allowed_reward_for_next_block();
        if !block.is_valid(expected_difficulty, expected_reward) {
            return Err(format!(
                "received block failed validation; expected difficulty {expected_difficulty} and reward {expected_reward}"
            ));
        }

        self.validate_spending(block.normal_transactions())?;

        let new_supply = self.circulating_supply + block.coinbase_amount();
        if new_supply > MAX_COIN_SUPPLY {
            return Err(format!(
                "received block would exceed max supply of {MAX_COIN_SUPPLY} XYQON"
            ));
        }

        self.circulating_supply = new_supply;
        self.chain.push(block);
        Ok(())
    }

    fn is_valid(&self) -> bool {
        let mut total_supply = 0.0;
        let mut balances = WalletBalances::new();

        for i in 1..self.chain.len() {
            let current = &self.chain[i];
            let previous = &self.chain[i - 1];
            let expected_difficulty =
                expected_difficulty_for_next_block(previous, current.timestamp);
            let expected_reward = allowed_mining_reward_for_block(current.index, total_supply);

            if !current.is_valid(expected_difficulty, expected_reward) {
                return false;
            }

            if current.previous_hash != previous.hash {
                return false;
            }

            if !balances.apply_block(current) {
                return false;
            }

            total_supply += current.coinbase_amount();
            if total_supply > MAX_COIN_SUPPLY {
                return false;
            }
        }

        amounts_equal(total_supply, self.circulating_supply)
    }

    fn current_supply(&self) -> f64 {
        self.circulating_supply
    }

    fn allowed_reward_for_next_block(&self) -> f64 {
        allowed_mining_reward_for_block(self.latest_block().index + 1, self.circulating_supply)
    }

    fn recalculate_circulating_supply(&mut self) {
        self.circulating_supply = self.chain.iter().skip(1).map(Block::coinbase_amount).sum();
    }

    fn wallet_balance(&self, wallet: &WalletFile) -> f64 {
        self.balance_for_public_key(&wallet.public_key)
    }

    fn balance_for_public_key(&self, public_key: &str) -> f64 {
        WalletBalances::from_chain(&self.chain).balance(public_key)
    }

    fn validate_spending(&self, transactions: &[Transaction]) -> Result<(), String> {
        let mut balances = WalletBalances::from_chain(&self.chain);
        for transaction in transactions {
            balances.apply_signed_transaction(transaction)?;
        }

        Ok(())
    }

    fn replace_with_better_chain(&mut self, candidate: Blockchain) -> Result<bool, String> {
        if !candidate.is_valid() {
            return Err("candidate chain is invalid".to_string());
        }

        if candidate.chain_score() <= self.chain_score() {
            return Ok(false);
        }

        *self = candidate;
        self.recalculate_circulating_supply();
        Ok(true)
    }

    fn chain_score(&self) -> u128 {
        self.chain
            .iter()
            .skip(1)
            .map(|block| 1_u128 << block.difficulty.min(63))
            .sum()
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
enum NetworkMessage {
    NewBlock(Block),
    NewTransaction(Transaction),
    RequestChain,
    ChainResponse(Blockchain),
}

struct Node {
    blockchain: Arc<Mutex<Blockchain>>,
    mempool: Arc<Mutex<Vec<Transaction>>>,
    peers: Vec<String>,
    chain_path: String,
}

impl Node {
    fn new(peers: Vec<String>, chain_path: String) -> Result<Self, String> {
        Ok(Node {
            blockchain: Arc::new(Mutex::new(Blockchain::load_or_new(&chain_path)?)),
            mempool: Arc::new(Mutex::new(Vec::new())),
            peers,
            chain_path,
        })
    }

    fn start_listener(&self, listen_addr: String) {
        let blockchain = Arc::clone(&self.blockchain);
        let mempool = Arc::clone(&self.mempool);
        let peers = self.peers.clone();
        let chain_path = self.chain_path.clone();

        thread::spawn(move || {
            let listener =
                TcpListener::bind(&listen_addr).expect("node should bind to listen address");
            println!("Listening for blocks on {listen_addr}");

            for stream in listener.incoming() {
                match stream {
                    Ok(stream) => {
                        let blockchain = Arc::clone(&blockchain);
                        let mempool = Arc::clone(&mempool);
                        let peers = peers.clone();
                        let chain_path = chain_path.clone();
                        thread::spawn(move || {
                            handle_peer_stream(stream, blockchain, mempool, peers, chain_path)
                        });
                    }
                    Err(error) => eprintln!("Failed to accept peer connection: {error}"),
                }
            }
        });
    }

    fn submit_transaction(&self, transaction: Transaction) -> Result<(), String> {
        add_transaction_to_mempool(&self.blockchain, &self.mempool, transaction.clone())?;
        self.broadcast_transaction(&transaction);
        Ok(())
    }

    fn mine_pending_transactions(&self, miner_reward_recipient: String) -> Result<(), String> {
        let transactions = {
            let mempool = self
                .mempool
                .lock()
                .map_err(|_| "mempool lock was poisoned".to_string())?;
            mempool.clone()
        };

        let block = {
            let mut blockchain = self
                .blockchain
                .lock()
                .map_err(|_| "blockchain lock was poisoned".to_string())?;
            let block = blockchain.add_block(transactions, miner_reward_recipient)?;
            save_blockchain(&blockchain, &self.chain_path)?;
            block
        };

        remove_block_transactions_from_mempool(&self.mempool, &block)?;
        self.broadcast_block(&block);
        Ok(())
    }

    fn broadcast_block(&self, block: &Block) {
        broadcast_block_to_peers(block, &self.peers);
    }

    fn broadcast_transaction(&self, transaction: &Transaction) {
        broadcast_transaction_to_peers(transaction, &self.peers);
    }

    fn sync_chain_from_peers(&self) {
        for peer in &self.peers {
            match request_chain_from_peer(peer) {
                Ok(candidate) => {
                    let result = self
                        .blockchain
                        .lock()
                        .map_err(|_| "blockchain lock was poisoned".to_string())
                        .and_then(|mut blockchain| {
                            let replaced = blockchain.replace_with_better_chain(candidate)?;
                            if replaced {
                                save_blockchain(&blockchain, &self.chain_path)?;
                            }
                            Ok(replaced)
                        });

                    match result {
                        Ok(true) => println!("Synced a better chain from {peer}"),
                        Ok(false) => println!("Local chain is already at least as good as {peer}"),
                        Err(error) => eprintln!("Could not sync chain from {peer}: {error}"),
                    }
                }
                Err(error) => eprintln!("Could not request chain from {peer}: {error}"),
            }
        }
    }

    fn print_chain(&self) {
        let Ok(blockchain) = self.blockchain.lock() else {
            eprintln!("Could not read blockchain");
            return;
        };

        println!("\nBlockchain:");
        for block in &blockchain.chain {
            println!("{block:#?}");
        }
        if let Ok(mempool) = self.mempool.lock() {
            println!("\nPending transactions: {}", mempool.len());
        }
        println!(
            "\nCirculating supply: {} / {} XYQON",
            blockchain.current_supply(),
            MAX_COIN_SUPPLY
        );
        println!("\nIs blockchain valid? {}", blockchain.is_valid());
    }
}

fn handle_peer_stream(
    stream: TcpStream,
    blockchain: Arc<Mutex<Blockchain>>,
    mempool: Arc<Mutex<Vec<Transaction>>>,
    peers: Vec<String>,
    chain_path: String,
) {
    let mut reader = BufReader::new(stream);

    loop {
        let mut line = String::new();
        let Ok(bytes_read) = reader.read_line(&mut line) else {
            eprintln!("Failed to read message from peer");
            continue;
        };

        if bytes_read == 0 {
            break;
        }

        let Ok(message) = serde_json::from_str::<NetworkMessage>(&line) else {
            eprintln!("Received invalid network message");
            continue;
        };

        match message {
            NetworkMessage::NewBlock(block) => {
                let block_index = block.index;
                let result = blockchain
                    .lock()
                    .map_err(|_| "blockchain lock was poisoned".to_string())
                    .and_then(|mut blockchain| {
                        blockchain.add_received_block(block)?;
                        save_blockchain(&blockchain, &chain_path)?;
                        Ok(())
                    });

                match result {
                    Ok(()) => {
                        println!("Accepted block {block_index} from peer");
                        if let Ok(blockchain) = blockchain.lock() {
                            let block = blockchain.latest_block().clone();
                            drop(blockchain);
                            if let Err(error) =
                                remove_block_transactions_from_mempool(&mempool, &block)
                            {
                                eprintln!("Could not clean mempool after block: {error}");
                            }
                            broadcast_block_to_peers(&block, &peers);
                        }
                    }
                    Err(error) => eprintln!("Rejected block {block_index}: {error}"),
                }
            }
            NetworkMessage::NewTransaction(transaction) => {
                let transaction_id = transaction.id();
                match add_transaction_to_mempool(&blockchain, &mempool, transaction.clone()) {
                    Ok(()) => {
                        println!("Accepted transaction {transaction_id} into mempool");
                        broadcast_transaction_to_peers(&transaction, &peers);
                    }
                    Err(error) => eprintln!("Rejected transaction {transaction_id}: {error}"),
                }
            }
            NetworkMessage::RequestChain => {
                let response = blockchain
                    .lock()
                    .map(|blockchain| NetworkMessage::ChainResponse(blockchain.clone()));

                match response {
                    Ok(response) => match serde_json::to_string(&response) {
                        Ok(serialized) => {
                            if let Err(error) = writeln!(reader.get_mut(), "{serialized}") {
                                eprintln!("Failed to send chain response: {error}");
                            }
                        }
                        Err(error) => eprintln!("Failed to serialize chain response: {error}"),
                    },
                    Err(_) => eprintln!("Could not read chain for sync response"),
                }
            }
            NetworkMessage::ChainResponse(_) => {
                eprintln!("Unexpected chain response on listener connection");
            }
        }
    }
}

#[derive(Debug)]
enum Command {
    Node(NodeConfig),
    WalletNew(WalletNewConfig),
    WalletExport(WalletExportConfig),
    WalletBalance(WalletBalanceConfig),
    Help,
}

#[derive(Debug)]
struct NodeConfig {
    listen_addr: Option<String>,
    peers: Vec<String>,
    mine_demo_block: bool,
    wallet_path: Option<String>,
    chain_path: String,
    recipient: Option<String>,
    amount: f64,
}

#[derive(Debug)]
struct WalletNewConfig {
    name: String,
    output_path: String,
}

#[derive(Debug)]
struct WalletExportConfig {
    wallet_path: String,
    show_private: bool,
}

#[derive(Debug)]
struct WalletBalanceConfig {
    wallet_path: String,
    chain_path: String,
}

impl Command {
    fn from_args() -> Result<Self, String> {
        let mut args: Vec<String> = env::args().skip(1).collect();
        if args.is_empty() {
            return Ok(Command::Help);
        }

        let command = args.remove(0);
        match command.as_str() {
            "node" => NodeConfig::from_args(args).map(Command::Node),
            "wallet" => parse_wallet_command(args),
            "help" | "--help" | "-h" => Ok(Command::Help),
            _ => Err(format!("unknown command: {command}")),
        }
    }
}

impl NodeConfig {
    fn from_args(args: Vec<String>) -> Result<Self, String> {
        let mut listen_addr = None;
        let mut peers = Vec::new();
        let mut mine_demo_block = false;
        let mut wallet_path = None;
        let mut chain_path = "xyqon-chain.json".to_string();
        let mut recipient = None;
        let mut amount = 1.0;
        let mut args = args.into_iter();

        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--listen" => listen_addr = args.next(),
                "--peer" => {
                    if let Some(peer) = args.next() {
                        peers.push(peer);
                    }
                }
                "--mine-demo" => mine_demo_block = true,
                "--wallet" => wallet_path = args.next(),
                "--chain" => {
                    chain_path = args
                        .next()
                        .ok_or_else(|| "--chain requires a file path".to_string())?;
                }
                "--to" => {
                    recipient = Some(
                        args.next()
                            .ok_or_else(|| "--to requires a recipient".to_string())?,
                    );
                }
                "--amount" => {
                    let value = args
                        .next()
                        .ok_or_else(|| "--amount requires a number".to_string())?;
                    amount = value
                        .parse::<f64>()
                        .map_err(|_| format!("invalid amount: {value}"))?;
                }
                _ => return Err(format!("unknown node option: {arg}")),
            }
        }

        Ok(NodeConfig {
            listen_addr,
            peers,
            mine_demo_block,
            wallet_path,
            chain_path,
            recipient,
            amount,
        })
    }
}

fn parse_wallet_command(mut args: Vec<String>) -> Result<Command, String> {
    if args.is_empty() {
        return Ok(Command::Help);
    }

    let command = args.remove(0);
    match command.as_str() {
        "new" => {
            let mut name = "unnamed".to_string();
            let mut output_path = "wallet.json".to_string();
            let mut args = args.into_iter();

            while let Some(arg) = args.next() {
                match arg.as_str() {
                    "--name" => {
                        name = args
                            .next()
                            .ok_or_else(|| "--name requires a wallet name".to_string())?;
                    }
                    "--out" => {
                        output_path = args
                            .next()
                            .ok_or_else(|| "--out requires a file path".to_string())?;
                    }
                    _ => return Err(format!("unknown wallet new option: {arg}")),
                }
            }

            Ok(Command::WalletNew(WalletNewConfig { name, output_path }))
        }
        "export" => {
            let mut wallet_path = None;
            let mut show_private = false;
            let mut args = args.into_iter();

            while let Some(arg) = args.next() {
                match arg.as_str() {
                    "--wallet" => wallet_path = args.next(),
                    "--show-private" => show_private = true,
                    _ => return Err(format!("unknown wallet export option: {arg}")),
                }
            }

            let wallet_path =
                wallet_path.ok_or_else(|| "wallet export requires --wallet <path>".to_string())?;
            Ok(Command::WalletExport(WalletExportConfig {
                wallet_path,
                show_private,
            }))
        }
        "balance" => {
            let mut wallet_path = None;
            let mut chain_path = "xyqon-chain.json".to_string();
            let mut args = args.into_iter();

            while let Some(arg) = args.next() {
                match arg.as_str() {
                    "--wallet" => wallet_path = args.next(),
                    "--chain" => {
                        chain_path = args
                            .next()
                            .ok_or_else(|| "--chain requires a file path".to_string())?;
                    }
                    _ => return Err(format!("unknown wallet balance option: {arg}")),
                }
            }

            let wallet_path =
                wallet_path.ok_or_else(|| "wallet balance requires --wallet <path>".to_string())?;
            Ok(Command::WalletBalance(WalletBalanceConfig {
                wallet_path,
                chain_path,
            }))
        }
        _ => Err(format!("unknown wallet command: {command}")),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        print_help();
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    match Command::from_args()? {
        Command::Node(config) => run_node(config),
        Command::WalletNew(config) => create_wallet(config),
        Command::WalletExport(config) => export_wallet(config),
        Command::WalletBalance(config) => show_wallet_balance(config),
        Command::Help => {
            print_help();
            Ok(())
        }
    }
}

fn run_node(config: NodeConfig) -> Result<(), String> {
    let has_listener = config.listen_addr.is_some();
    let node = Node::new(config.peers, config.chain_path)?;

    if let Some(listen_addr) = config.listen_addr {
        node.start_listener(listen_addr);
    }

    node.sync_chain_from_peers();

    if let Some(wallet_path) = config.wallet_path {
        let wallet = WalletFile::load(&wallet_path)?;
        let signing_key = wallet.signing_key()?;
        if let Some(recipient) = config.recipient {
            node.submit_transaction(Transaction::new(
                &wallet.name,
                &recipient,
                config.amount,
                &signing_key,
            ))?;
        }
        node.mine_pending_transactions(wallet.public_key)?;
    } else if config.mine_demo_block || (!has_listener && node.peers.is_empty()) {
        let demo_wallet = WalletFile::generate("demo".to_string());
        let signing_key = demo_wallet.signing_key()?;

        node.submit_transaction(Transaction::new(
            &demo_wallet.name,
            "network",
            1.0,
            &signing_key,
        ))?;
        node.mine_pending_transactions(demo_wallet.public_key)?;
    }

    node.print_chain();

    if has_listener || !node.peers.is_empty() {
        loop {
            thread::sleep(Duration::from_secs(60));
        }
    }

    Ok(())
}

fn create_wallet(config: WalletNewConfig) -> Result<(), String> {
    if Path::new(&config.output_path).exists() {
        return Err(format!(
            "wallet file already exists: {}",
            config.output_path
        ));
    }

    let wallet = WalletFile::generate(config.name);
    wallet.save(&config.output_path)?;
    println!("Created wallet: {}", config.output_path);
    println!("Public key: {}", wallet.public_key);
    Ok(())
}

fn export_wallet(config: WalletExportConfig) -> Result<(), String> {
    let wallet = WalletFile::load(&config.wallet_path)?;

    println!("Wallet: {}", wallet.name);
    println!("Public key: {}", wallet.public_key);
    if config.show_private {
        println!("Private key: {}", wallet.private_key);
    } else {
        println!("Private key: hidden; pass --show-private to display it");
    }

    Ok(())
}

fn show_wallet_balance(config: WalletBalanceConfig) -> Result<(), String> {
    let wallet = WalletFile::load(&config.wallet_path)?;
    let blockchain = Blockchain::load_or_new(&config.chain_path)?;
    let balance = blockchain.wallet_balance(&wallet);

    println!("Wallet: {}", wallet.name);
    println!("Public key: {}", wallet.public_key);
    println!("Chain: {}", config.chain_path);
    println!("Balance: {balance} XYQON");
    println!(
        "Circulating supply: {} / {} XYQON",
        blockchain.current_supply(),
        MAX_COIN_SUPPLY
    );

    Ok(())
}

fn broadcast_block_to_peers(block: &Block, peers: &[String]) {
    let message = NetworkMessage::NewBlock(block.clone());
    let Ok(serialized) = serde_json::to_string(&message) else {
        eprintln!("Failed to serialize block for broadcast");
        return;
    };

    for peer in peers {
        match TcpStream::connect(peer) {
            Ok(mut stream) => {
                if let Err(error) = writeln!(stream, "{serialized}") {
                    eprintln!("Failed to send block to {peer}: {error}");
                } else {
                    println!("Shared block {} with {peer}", block.index);
                }
            }
            Err(error) => eprintln!("Could not connect to peer {peer}: {error}"),
        }
    }
}

fn save_blockchain(blockchain: &Blockchain, path: &str) -> Result<(), String> {
    if let Some(parent) = Path::new(path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create chain directory: {error}"))?;
        }
    }

    let contents = serde_json::to_string_pretty(blockchain)
        .map_err(|error| format!("failed to serialize chain: {error}"))?;
    fs::write(path, contents).map_err(|error| format!("failed to save chain: {error}"))
}

fn broadcast_transaction_to_peers(transaction: &Transaction, peers: &[String]) {
    let message = NetworkMessage::NewTransaction(transaction.clone());
    let Ok(serialized) = serde_json::to_string(&message) else {
        eprintln!("Failed to serialize transaction for broadcast");
        return;
    };

    for peer in peers {
        match TcpStream::connect(peer) {
            Ok(mut stream) => {
                if let Err(error) = writeln!(stream, "{serialized}") {
                    eprintln!("Failed to send transaction to {peer}: {error}");
                } else {
                    println!("Shared transaction {} with {peer}", transaction.id());
                }
            }
            Err(error) => eprintln!("Could not connect to peer {peer}: {error}"),
        }
    }
}

fn request_chain_from_peer(peer: &str) -> Result<Blockchain, String> {
    let mut stream =
        TcpStream::connect(peer).map_err(|error| format!("could not connect: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| format!("could not set read timeout: {error}"))?;

    let request = serde_json::to_string(&NetworkMessage::RequestChain)
        .map_err(|error| format!("could not serialize chain request: {error}"))?;
    writeln!(stream, "{request}").map_err(|error| format!("could not send request: {error}"))?;

    let mut reader = BufReader::new(stream);
    let mut response = String::new();
    reader
        .read_line(&mut response)
        .map_err(|error| format!("could not read response: {error}"))?;

    match serde_json::from_str::<NetworkMessage>(&response)
        .map_err(|error| format!("could not parse response: {error}"))?
    {
        NetworkMessage::ChainResponse(mut blockchain) => {
            blockchain.recalculate_circulating_supply();
            if !blockchain.is_valid() {
                return Err("peer returned an invalid chain".to_string());
            }
            Ok(blockchain)
        }
        _ => Err("peer did not return a chain response".to_string()),
    }
}

fn add_transaction_to_mempool(
    blockchain: &Arc<Mutex<Blockchain>>,
    mempool: &Arc<Mutex<Vec<Transaction>>>,
    transaction: Transaction,
) -> Result<(), String> {
    if !transaction.is_valid_signed_transaction() {
        return Err("transaction signature is invalid".to_string());
    }

    let transaction_id = transaction.id();
    let mut mempool = mempool
        .lock()
        .map_err(|_| "mempool lock was poisoned".to_string())?;

    if mempool
        .iter()
        .any(|existing| existing.id() == transaction_id)
    {
        return Err("transaction is already in the mempool".to_string());
    }

    let blockchain = blockchain
        .lock()
        .map_err(|_| "blockchain lock was poisoned".to_string())?;
    let mut balances = WalletBalances::from_chain(&blockchain.chain);
    for pending in mempool.iter() {
        balances.apply_signed_transaction(pending)?;
    }
    balances.apply_signed_transaction(&transaction)?;
    drop(blockchain);

    mempool.push(transaction);
    Ok(())
}

fn remove_block_transactions_from_mempool(
    mempool: &Arc<Mutex<Vec<Transaction>>>,
    block: &Block,
) -> Result<(), String> {
    let confirmed_ids: Vec<String> = block
        .transactions
        .iter()
        .skip(1)
        .map(Transaction::id)
        .collect();
    let mut mempool = mempool
        .lock()
        .map_err(|_| "mempool lock was poisoned".to_string())?;

    mempool.retain(|transaction| !confirmed_ids.contains(&transaction.id()));
    Ok(())
}

fn mining_reward_for_block(block_index: u64) -> f64 {
    if block_index == 0 {
        return 0.0;
    }

    let halvings = (block_index - 1) / HALVING_INTERVAL;
    INITIAL_MINING_REWARD / 2_f64.powi(halvings as i32)
}

fn allowed_mining_reward_for_block(block_index: u64, current_supply: f64) -> f64 {
    let scheduled_reward = mining_reward_for_block(block_index);
    let remaining_supply = (MAX_COIN_SUPPLY - current_supply).max(0.0);
    scheduled_reward.min(remaining_supply)
}

fn expected_difficulty_for_next_block(previous: &Block, next_timestamp: i64) -> usize {
    if previous.index == 0 {
        return INITIAL_DIFFICULTY;
    }

    let elapsed_seconds = next_timestamp - previous.timestamp;
    if elapsed_seconds < TARGET_BLOCK_TIME_SECONDS {
        previous.difficulty + 1
    } else if elapsed_seconds > TARGET_BLOCK_TIME_SECONDS {
        previous.difficulty.saturating_sub(1).max(MIN_DIFFICULTY)
    } else {
        previous.difficulty
    }
}

fn amounts_equal(left: f64, right: f64) -> bool {
    (left - right).abs() < 0.000_000_01
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hex_to_array<const N: usize>(hex: &str) -> Option<[u8; N]> {
    if hex.len() != N * 2 {
        return None;
    }

    let mut bytes = [0_u8; N];
    for (index, chunk) in hex.as_bytes().chunks_exact(2).enumerate() {
        let part = std::str::from_utf8(chunk).ok()?;
        bytes[index] = u8::from_str_radix(part, 16).ok()?;
    }

    Some(bytes)
}

fn print_help() {
    println!(
        r#"xyqon

USAGE:
  xyqon node [OPTIONS]
  xyqon wallet new --name <NAME> --out <FILE>
  xyqon wallet export --wallet <FILE> [--show-private]
  xyqon wallet balance --wallet <FILE> [--chain <FILE>]

NODE OPTIONS:
  --listen <ADDR>       Listen for peer blocks, for example 127.0.0.1:7101 or 0.0.0.0:7101 on Linux
  --peer <ADDR>         Add a peer to share accepted blocks with. Can be repeated
  --wallet <FILE>       Wallet used to mine at startup; omit --to for a coinbase-only block
  --chain <FILE>        Chain storage file. Defaults to xyqon-chain.json
  --to <RECIPIENT>      Optional recipient name for a startup transaction
  --amount <AMOUNT>     Amount for the startup transaction
  --mine-demo           Mine a demo block at startup

MINING:
  Signed startup transactions enter the mempool before they are mined.
  Mining collects pending mempool transactions into the next block.
  Each mined block receives one coinbase reward transaction.
  The initial reward is 10.0 XYQON and halves every 100,000 blocks.
  Difficulty adjusts dynamically to target one block every 30 seconds.
  When --wallet is used, the reward is paid to that wallet's public key.
  Total coin supply is capped at 67,000,000 XYQON.
  If remaining supply is less than the scheduled reward, only the remaining supply can be minted.

WALLET COMMANDS:
  wallet new            Create a new Ed25519 wallet file
  wallet export         Print wallet public key, and optionally private key
  wallet balance        Calculate wallet balance from the saved chain
"#
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mining_reward_halves_every_100_000_blocks() {
        assert_eq!(mining_reward_for_block(0), 0.0);
        assert_eq!(mining_reward_for_block(1), 10.0);
        assert_eq!(mining_reward_for_block(100_000), 10.0);
        assert_eq!(mining_reward_for_block(100_001), 5.0);
        assert_eq!(mining_reward_for_block(200_000), 5.0);
        assert_eq!(mining_reward_for_block(200_001), 2.5);
    }

    #[test]
    fn difficulty_adjusts_toward_30_second_blocks() {
        let mut previous = Blockchain::genesis_block();
        assert_eq!(
            expected_difficulty_for_next_block(&previous, previous.timestamp + 5),
            INITIAL_DIFFICULTY
        );

        previous.index = 1;
        previous.difficulty = 4;
        assert_eq!(
            expected_difficulty_for_next_block(&previous, previous.timestamp + 29),
            5
        );
        assert_eq!(
            expected_difficulty_for_next_block(&previous, previous.timestamp + 30),
            4
        );
        assert_eq!(
            expected_difficulty_for_next_block(&previous, previous.timestamp + 31),
            3
        );

        previous.difficulty = MIN_DIFFICULTY;
        assert_eq!(
            expected_difficulty_for_next_block(&previous, previous.timestamp + 31),
            MIN_DIFFICULTY
        );
    }

    #[test]
    fn mining_reward_is_limited_by_remaining_supply() {
        assert_eq!(allowed_mining_reward_for_block(1, 0.0), 10.0);
        assert_eq!(
            allowed_mining_reward_for_block(1, MAX_COIN_SUPPLY - 3.0),
            3.0
        );
        assert_eq!(allowed_mining_reward_for_block(1, MAX_COIN_SUPPLY), 0.0);
    }

    #[test]
    fn chain_rejects_overspending_transactions() {
        let miner_key = SigningKey::from_bytes(&[7; 32]);
        let miner_public_key = bytes_to_hex(miner_key.verifying_key().as_bytes());
        let mut blockchain = Blockchain::new();

        blockchain
            .add_block(vec![], miner_public_key.clone())
            .expect("coinbase-only block should mine");

        let overspend = Transaction::new("miner", "receiver", 11.0, &miner_key);
        let result = blockchain.add_block(vec![overspend], miner_public_key);

        assert!(result.is_err());
    }

    #[test]
    fn chain_replaces_itself_with_better_valid_chain() {
        let miner_key = SigningKey::from_bytes(&[8; 32]);
        let miner_public_key = bytes_to_hex(miner_key.verifying_key().as_bytes());
        let mut local = Blockchain::new();
        let mut candidate = Blockchain::new();

        candidate
            .add_block(vec![], miner_public_key)
            .expect("candidate should mine a better chain");

        assert!(local
            .replace_with_better_chain(candidate)
            .expect("valid better chain should be accepted"));
        assert_eq!(local.latest_block().index, 1);
        assert_eq!(local.current_supply(), 10.0);
    }
}
