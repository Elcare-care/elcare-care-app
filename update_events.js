const fs = require('fs');

let content = fs.readFileSync('contracts/soroban-marketplace/src/events.rs', 'utf8');

content = content.replace(/\/\/ Versioned event topics as Symbol constants/g, '// Versioned event topics as string constants');

const constants = [
  'LISTING_CREATED', 'ARTWORK_SOLD', 'LISTING_CANCELLED', 'LISTING_UPDATED',
  'BID_PLACED', 'AUCTION_RESOLVED', 'AUCTION_CREATED', 'OFFER_MADE',
  'OFFER_ACCEPTED', 'OFFER_REJECTED', 'OFFER_WITHDRAWN', 'ROYALTY_PAID',
  'ADMIN_TRANSFER_PROPOSED', 'ADMIN_TRANSFERRED', 'ARTIST_REVOKED', 'ARTIST_REINSTATED',
  'CONTRACT_PAUSED', 'CONTRACT_UNPAUSED', 'LISTING_PRICE_UPDATED', 'LISTING_EXPIRED',
  'AUCTION_EXTENDED', 'AUCTION_CANCELLED', 'PROTOCOL_FEE_COLLECTED', 'OFFER_RECLAIMED'
];

for (const constant of constants) {
  // Replace the constant definition
  const regexDef = new RegExp(`pub const ${constant}: Symbol = symbol_short!\\(".*"\\);`, 'g');
  content = content.replace(regexDef, `pub const ${constant}: &str = "${constant.toLowerCase()}";`);
  
  // Replace the publish call
  const regexPub = new RegExp(`\\((${constant}),\\)`, 'g');
  content = content.replace(regexPub, `(soroban_sdk::Symbol::new(env, $1),)`);
}

// Remove the unused import of symbol_short!
content = content.replace(/use soroban_sdk::\{contracttype, symbol_short, Address, Env, Symbol\};/, 'use soroban_sdk::{contracttype, Address, Env, Symbol};');

fs.writeFileSync('contracts/soroban-marketplace/src/events.rs', content);
console.log('Successfully updated events.rs');
