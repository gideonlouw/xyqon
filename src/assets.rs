use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use crate::{Block, Transaction};

const ASSET_AMOUNT_EPSILON: f64 = 0.000_000_01;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum AssetOperation {
    CreateCoin(CoinCreation),
    TransferCoin(CoinTransfer),
    RegisterCollection(CollectionRegistration),
    UpdateCollection(CollectionUpdate),
    LockCollection(CollectionLock),
    MintNft(NftMint),
    TransferNft(NftTransfer),
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct CollectionRegistration {
    pub collection: String,
    pub authorized_minters: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata_url: Option<String>,
    pub authority_mutable: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct CollectionUpdate {
    pub collection: String,
    pub authorized_minters: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata_url: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct CollectionLock {
    pub collection: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct CoinCreation {
    pub symbol: String,
    pub name: String,
    pub supply: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct CoinTransfer {
    pub symbol: String,
    pub amount: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct NftMint {
    pub collection: String,
    pub token_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct NftTransfer {
    pub collection: String,
    pub token_id: String,
}

#[derive(Debug, Clone)]
pub struct NftRecord {
    pub owner_public_key: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CollectionRecord {
    pub creator_public_key: String,
    pub authorized_minters: Vec<String>,
    pub metadata_url: Option<String>,
    pub authority_mutable: bool,
    pub locked: bool,
}

#[derive(Debug, Default, Clone)]
pub struct AssetLedger {
    coin_symbols: HashSet<String>,
    balances: HashMap<(String, String), f64>,
    collections: HashMap<String, CollectionRecord>,
    nfts: HashMap<(String, String), NftRecord>,
}

impl AssetOperation {
    pub fn create_coin(symbol: String, name: String, supply: f64) -> Result<Self, String> {
        let symbol = normalize_symbol(&symbol)?;
        let name = normalize_name(&name)?;
        validate_token_amount(supply, "coin supply")?;
        Ok(AssetOperation::CreateCoin(CoinCreation {
            symbol,
            name,
            supply,
        }))
    }

    pub fn transfer_coin(symbol: String, amount: f64) -> Result<Self, String> {
        let symbol = normalize_symbol(&symbol)?;
        validate_token_amount(amount, "coin transfer amount")?;
        Ok(AssetOperation::TransferCoin(CoinTransfer {
            symbol,
            amount,
        }))
    }

    #[cfg(test)]
    pub fn register_collection(
        collection: String,
        authorized_minters: Vec<String>,
        metadata_url: Option<String>,
        authority_mutable: bool,
    ) -> Result<Self, String> {
        Ok(AssetOperation::RegisterCollection(CollectionRegistration {
            collection: normalize_symbol(&collection)?,
            authorized_minters: normalize_minters(authorized_minters)?,
            metadata_url: normalize_optional_metadata_url(metadata_url)?,
            authority_mutable,
        }))
    }

    #[cfg(test)]
    pub fn update_collection(
        collection: String,
        authorized_minters: Vec<String>,
        metadata_url: Option<String>,
    ) -> Result<Self, String> {
        Ok(AssetOperation::UpdateCollection(CollectionUpdate {
            collection: normalize_symbol(&collection)?,
            authorized_minters: normalize_minters(authorized_minters)?,
            metadata_url: normalize_optional_metadata_url(metadata_url)?,
        }))
    }

    #[cfg(test)]
    pub fn lock_collection(collection: String) -> Result<Self, String> {
        Ok(AssetOperation::LockCollection(CollectionLock {
            collection: normalize_symbol(&collection)?,
        }))
    }

    pub fn mint_nft(
        collection: String,
        token_id: String,
        name: String,
        image_url: Option<String>,
    ) -> Result<Self, String> {
        let collection = normalize_symbol(&collection)?;
        let token_id = normalize_token_id(&token_id)?;
        let name = normalize_name(&name)?;
        let image_url = normalize_optional_image_url(image_url)?;
        Ok(AssetOperation::MintNft(NftMint {
            collection,
            token_id,
            name,
            image_url,
        }))
    }

    pub fn transfer_nft(collection: String, token_id: String) -> Result<Self, String> {
        let collection = normalize_symbol(&collection)?;
        let token_id = normalize_token_id(&token_id)?;
        Ok(AssetOperation::TransferNft(NftTransfer {
            collection,
            token_id,
        }))
    }

    pub fn requires_zero_xyqon_amount(&self) -> bool {
        match self {
            AssetOperation::CreateCoin(_)
            | AssetOperation::TransferCoin(_)
            | AssetOperation::RegisterCollection(_)
            | AssetOperation::UpdateCollection(_)
            | AssetOperation::LockCollection(_)
            | AssetOperation::MintNft(_)
            | AssetOperation::TransferNft(_) => true,
        }
    }
}

impl AssetLedger {
    pub fn new() -> Self {
        AssetLedger {
            coin_symbols: HashSet::new(),
            balances: HashMap::new(),
            collections: HashMap::new(),
            nfts: HashMap::new(),
        }
    }

    pub fn from_chain(chain: &[Block]) -> Result<Self, String> {
        let mut ledger = AssetLedger::new();
        for block in chain.iter().skip(1) {
            ledger.apply_block(block)?;
        }
        Ok(ledger)
    }

    pub fn apply_block(&mut self, block: &Block) -> Result<(), String> {
        for transaction in block.normal_transactions() {
            self.apply_transaction(transaction)?;
        }
        Ok(())
    }

    pub fn apply_transaction(&mut self, transaction: &Transaction) -> Result<(), String> {
        let Some(operation) = transaction.asset_operation.as_ref() else {
            return Ok(());
        };

        if !amounts_equal(transaction.amount, 0.0) {
            return Err("asset transactions must use a 0 XYQON amount".to_string());
        }

        match operation {
            AssetOperation::CreateCoin(coin) => self.create_coin(transaction, coin),
            AssetOperation::TransferCoin(transfer) => self.transfer_coin(transaction, transfer),
            AssetOperation::RegisterCollection(registration) => {
                self.register_collection(transaction, registration)
            }
            AssetOperation::UpdateCollection(update) => self.update_collection(transaction, update),
            AssetOperation::LockCollection(lock) => self.lock_collection(transaction, lock),
            AssetOperation::MintNft(nft) => self.mint_nft(transaction, nft),
            AssetOperation::TransferNft(transfer) => self.transfer_nft(transaction, transfer),
        }
    }

    pub fn coin_exists(&self, symbol: &str) -> bool {
        self.coin_symbols.contains(&symbol.to_ascii_uppercase())
    }

    pub fn coin_balance(&self, symbol: &str, public_key: &str) -> f64 {
        *self
            .balances
            .get(&(symbol.to_ascii_uppercase(), public_key.to_string()))
            .unwrap_or(&0.0)
    }

    #[cfg(test)]
    pub fn nft_owner(&self, collection: &str, token_id: &str) -> Option<&str> {
        let key = (
            collection.to_ascii_uppercase(),
            token_id.trim().to_ascii_lowercase(),
        );
        self.nfts
            .get(&key)
            .map(|record| record.owner_public_key.as_str())
    }

    fn create_coin(
        &mut self,
        transaction: &Transaction,
        coin: &CoinCreation,
    ) -> Result<(), String> {
        let symbol = normalize_symbol(&coin.symbol)?;
        normalize_name(&coin.name)?;
        validate_token_amount(coin.supply, "coin supply")?;

        if self.coin_exists(&symbol) {
            return Err(format!("coin symbol already exists: {symbol}"));
        }

        let owner_public_key = transaction.sender_public_key.clone();
        if owner_public_key.is_empty() {
            return Err("coin creator public key cannot be empty".to_string());
        }

        self.coin_symbols.insert(symbol.clone());
        self.credit(&symbol, &owner_public_key, coin.supply);
        Ok(())
    }

    fn transfer_coin(
        &mut self,
        transaction: &Transaction,
        transfer: &CoinTransfer,
    ) -> Result<(), String> {
        let symbol = normalize_symbol(&transfer.symbol)?;
        validate_token_amount(transfer.amount, "coin transfer amount")?;

        if !self.coin_exists(&symbol) {
            return Err(format!("coin symbol does not exist: {symbol}"));
        }

        if transaction.recipient.is_empty() {
            return Err("coin transfer recipient cannot be empty".to_string());
        }

        let sender_public_key = &transaction.sender_public_key;
        let balance = self.coin_balance(&symbol, sender_public_key);
        if balance + ASSET_AMOUNT_EPSILON < transfer.amount {
            return Err(format!(
                "insufficient {symbol}; balance is {}, attempted to send {}",
                balance, transfer.amount
            ));
        }

        self.debit(&symbol, sender_public_key, transfer.amount);
        self.credit(&symbol, &transaction.recipient, transfer.amount);
        Ok(())
    }

    fn register_collection(
        &mut self,
        transaction: &Transaction,
        registration: &CollectionRegistration,
    ) -> Result<(), String> {
        let collection = normalize_symbol(&registration.collection)?;
        if self.collections.contains_key(&collection) {
            return Err(format!("collection is already registered: {collection}"));
        }
        let authorized_minters = normalize_minters(registration.authorized_minters.clone())?;
        let metadata_url = normalize_optional_metadata_url(registration.metadata_url.clone())?;
        validate_public_key(&transaction.sender_public_key)?;
        self.collections.insert(
            collection,
            CollectionRecord {
                creator_public_key: transaction.sender_public_key.clone(),
                authorized_minters,
                metadata_url,
                authority_mutable: registration.authority_mutable,
                locked: false,
            },
        );
        Ok(())
    }

    fn update_collection(
        &mut self,
        transaction: &Transaction,
        update: &CollectionUpdate,
    ) -> Result<(), String> {
        let collection = normalize_symbol(&update.collection)?;
        let authorized_minters = normalize_minters(update.authorized_minters.clone())?;
        let metadata_url = normalize_optional_metadata_url(update.metadata_url.clone())?;
        let record = self
            .collections
            .get_mut(&collection)
            .ok_or_else(|| format!("collection is not registered: {collection}"))?;
        if record.creator_public_key != transaction.sender_public_key {
            return Err(format!(
                "only the collection creator can update {collection}"
            ));
        }
        if record.locked {
            return Err(format!(
                "collection registry is permanently locked: {collection}"
            ));
        }
        if !record.authority_mutable {
            return Err(format!(
                "collection minting authority is immutable: {collection}"
            ));
        }
        record.authorized_minters = authorized_minters;
        record.metadata_url = metadata_url;
        Ok(())
    }

    fn lock_collection(
        &mut self,
        transaction: &Transaction,
        lock: &CollectionLock,
    ) -> Result<(), String> {
        let collection = normalize_symbol(&lock.collection)?;
        let record = self
            .collections
            .get_mut(&collection)
            .ok_or_else(|| format!("collection is not registered: {collection}"))?;
        if record.creator_public_key != transaction.sender_public_key {
            return Err(format!("only the collection creator can lock {collection}"));
        }
        if record.locked {
            return Err(format!(
                "collection registry is already locked: {collection}"
            ));
        }
        record.locked = true;
        Ok(())
    }

    fn mint_nft(&mut self, transaction: &Transaction, nft: &NftMint) -> Result<(), String> {
        let collection = normalize_symbol(&nft.collection)?;
        let token_id = normalize_token_id(&nft.token_id)?;
        normalize_name(&nft.name)?;
        normalize_optional_image_url(nft.image_url.clone())?;
        let key = (collection.clone(), token_id.clone());

        // Legacy, unregistered collections remain valid. Registration opts a collection into
        // consensus-enforced mint authority without invalidating the existing live chain.
        if let Some(record) = self.collections.get(&collection) {
            if !record
                .authorized_minters
                .contains(&transaction.sender_public_key)
            {
                return Err(format!(
                    "wallet is not authorized to mint NFTs in registered collection {collection}"
                ));
            }
        }

        if self.nfts.contains_key(&key) {
            return Err(format!("NFT already exists: {collection}:{token_id}"));
        }

        let owner_public_key = transaction.sender_public_key.clone();
        if owner_public_key.is_empty() {
            return Err("NFT creator public key cannot be empty".to_string());
        }

        self.nfts.insert(key, NftRecord { owner_public_key });
        Ok(())
    }

    fn transfer_nft(
        &mut self,
        transaction: &Transaction,
        transfer: &NftTransfer,
    ) -> Result<(), String> {
        let collection = normalize_symbol(&transfer.collection)?;
        let token_id = normalize_token_id(&transfer.token_id)?;
        let key = (collection.clone(), token_id.clone());

        if transaction.recipient.is_empty() {
            return Err("NFT transfer recipient cannot be empty".to_string());
        }

        let Some(record) = self.nfts.get_mut(&key) else {
            return Err(format!("NFT does not exist: {collection}:{token_id}"));
        };

        if record.owner_public_key != transaction.sender_public_key {
            return Err(format!(
                "NFT transfer sender does not own {collection}:{token_id}"
            ));
        }

        record.owner_public_key = transaction.recipient.clone();
        Ok(())
    }

    fn credit(&mut self, symbol: &str, public_key: &str, amount: f64) {
        *self
            .balances
            .entry((symbol.to_string(), public_key.to_string()))
            .or_insert(0.0) += amount;
    }

    fn debit(&mut self, symbol: &str, public_key: &str, amount: f64) {
        *self
            .balances
            .entry((symbol.to_string(), public_key.to_string()))
            .or_insert(0.0) -= amount;
    }
}

fn normalize_symbol(symbol: &str) -> Result<String, String> {
    let symbol = symbol.trim().to_ascii_uppercase();
    if symbol.len() < 2 || symbol.len() > 12 {
        return Err("coin symbol must be 2 to 12 characters".to_string());
    }

    if !symbol
        .chars()
        .all(|character| character.is_ascii_uppercase() || character.is_ascii_digit())
    {
        return Err("coin symbol can only contain letters and numbers".to_string());
    }

    Ok(symbol)
}

fn normalize_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 64 {
        return Err("coin name must be 1 to 64 characters".to_string());
    }

    Ok(name.to_string())
}

fn normalize_token_id(token_id: &str) -> Result<String, String> {
    let token_id = token_id.trim().to_ascii_lowercase();
    if token_id.is_empty() || token_id.len() > 64 {
        return Err("NFT token id must be 1 to 64 characters".to_string());
    }

    if !token_id.chars().all(|character| {
        character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || character == '-'
            || character == '_'
    }) {
        return Err(
            "NFT token id can only contain letters, numbers, hyphens, and underscores".to_string(),
        );
    }

    Ok(token_id)
}

fn normalize_optional_image_url(image_url: Option<String>) -> Result<Option<String>, String> {
    let Some(image_url) = image_url else {
        return Ok(None);
    };

    let image_url = image_url.trim().to_string();
    if image_url.is_empty() {
        return Ok(None);
    }

    if image_url.len() > 512 {
        return Err("NFT image URL cannot be longer than 512 characters".to_string());
    }

    let lowercase = image_url.to_ascii_lowercase();
    if !(lowercase.starts_with("https://") || lowercase.starts_with("http://")) {
        return Err("NFT image URL must start with http:// or https://".to_string());
    }

    Ok(Some(image_url))
}

fn normalize_optional_metadata_url(url: Option<String>) -> Result<Option<String>, String> {
    let Some(url) = url else {
        return Ok(None);
    };
    let url = url.trim().to_string();
    if url.is_empty() {
        return Ok(None);
    }
    if url.len() > 512 {
        return Err("collection metadata URL cannot be longer than 512 characters".to_string());
    }
    let lowercase = url.to_ascii_lowercase();
    if !(lowercase.starts_with("https://") || lowercase.starts_with("ipfs://")) {
        return Err("collection metadata URL must start with https:// or ipfs://".to_string());
    }
    Ok(Some(url))
}

fn validate_public_key(public_key: &str) -> Result<(), String> {
    if public_key.len() != 64
        || !public_key
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("authorized minter must be a 64-character Ed25519 public key".to_string());
    }
    Ok(())
}

fn normalize_minters(minters: Vec<String>) -> Result<Vec<String>, String> {
    if minters.is_empty() {
        return Err("collection requires at least one authorized minter".to_string());
    }
    if minters.len() > 32 {
        return Err("collection can have at most 32 authorized minters".to_string());
    }
    let mut normalized = Vec::new();
    for minter in minters {
        let minter = minter.trim().to_ascii_lowercase();
        validate_public_key(&minter)?;
        if !normalized.contains(&minter) {
            normalized.push(minter);
        }
    }
    Ok(normalized)
}

fn validate_token_amount(amount: f64, label: &str) -> Result<(), String> {
    if !amount.is_finite() || amount <= 0.0 {
        return Err(format!("{label} must be a positive finite number"));
    }

    if !amounts_equal(amount, round_to_token_precision(amount)) {
        return Err(format!("{label} can have at most 8 decimal places"));
    }

    Ok(())
}

fn round_to_token_precision(amount: f64) -> f64 {
    (amount * 100_000_000.0).round() / 100_000_000.0
}

fn amounts_equal(left: f64, right: f64) -> bool {
    (left - right).abs() < ASSET_AMOUNT_EPSILON
}
