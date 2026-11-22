#![no_std]
#![allow(clippy::too_many_arguments, deprecated)]

mod contract;
pub mod events;
mod storage;
mod types;

#[cfg(test)]
mod test;

#[cfg(test)]
mod registry_tests;

#[cfg(test)]
mod marketplace_fee_tests;

#[cfg(test)]
mod migration_tests;

#[cfg(test)]
mod salt_sequence_tests;

#[cfg(test)]
mod kind_matrix_tests;

pub use contract::Launchpad;
pub use storage::MigrationProgress;
pub use types::{CollectionKind, CollectionRecord, DataKey, Error, WasmHashes, CONTRACT_VERSION};

#[cfg(any(test, feature = "testutils"))]
pub use contract::LaunchpadClient;
