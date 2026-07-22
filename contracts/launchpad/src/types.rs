use soroban_sdk::{contracterror, contracttype, Address, BytesN, String};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    NotAdmin = 3,
    WasmHashNotSet = 4,
    InvalidFeeBps = 5,
    ContractPaused = 6,
    InvalidDeployFee = 7,
    NoPendingAdmin = 8,
    NotPendingAdmin = 9,
}

/// Which of the four collection types was deployed.
#[contracttype]
#[derive(Clone)]
pub enum CollectionKind {
    Normal721,
    Normal1155,
    LazyMint721,
    LazyMint1155,
}

/// A record stored for every deployed collection (issues #37 + #38).
#[contracttype]
#[derive(Clone)]
pub struct CollectionRecord {
    pub address: Address,
    pub kind: CollectionKind,
    pub creator: Address,
    pub name: String,
    pub symbol: String,
    pub ledger: u32,
    pub platform_fee_bps: u32,
}

/// The four collection WASM hashes plus a monotonically increasing version,
/// bumped on every `set_wasm_hashes` so indexers can track factory upgrades.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WasmHashes {
    pub normal_721: BytesN<32>,
    pub normal_1155: BytesN<32>,
    pub lazy_721: BytesN<32>,
    pub lazy_1155: BytesN<32>,
    pub version: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Initialized,
    Admin,
    PendingAdmin,
    Paused,
    /// Treasury address receiving the flat deployment fee; also forwarded to
    /// lazy-mint contracts as their `platform_fee_receiver`.
    FeeReceiver,
    /// Flat deployment fee in the deploy currency's smallest unit (i128).
    DeployFee,
    WasmNormal721,
    WasmNormal1155,
    WasmLazy721,
    WasmLazy1155,
    /// Incremented on every `set_wasm_hashes`.
    WasmVersion,
    CollectionCount,
    ByCreator(Address),
    AllCollections,
    CollectionByIndex(u64),
    CreatorCollectionCount(Address),
    CreatorCollectionByIndex(Address, u64),
    /// Direct lookup by collection address (#37)
    CollectionByAddress(Address),
}
