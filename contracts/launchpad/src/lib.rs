#![no_std]
#![allow(clippy::too_many_arguments, deprecated)]

mod contract;
pub mod events;
mod storage;
mod types;

#[cfg(test)]
mod test;

pub use contract::Launchpad;
pub use storage::MigrationProgress;
pub use types::{CollectionKind, CollectionRecord, DataKey, Error, WasmHashes, CONTRACT_VERSION};

#[cfg(any(test, feature = "testutils"))]
pub use contract::LaunchpadClient;
