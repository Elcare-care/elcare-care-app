const fs = require('fs');

const testCode = `
#[test]
fn test_event_catalog_topics() {
    let env = Env::default();
    
    // Verify all string constants can be published without Symbol limit panics
    
    let artist = Address::generate(&env);
    let collection = Address::generate(&env);
    let token = Address::generate(&env);
    
    let ev1 = crate::events::ListingCreatedEvent {
        listing_id: 1, artist: artist.clone(), price: 100,
        currency: soroban_sdk::Symbol::new(&env, "xlm"),
        collection: collection.clone(), token_id: 1, ledger_sequence: 1,
    };
    ev1.publish(&env);
    
    let ev2 = crate::events::ArtworkSoldEvent {
        listing_id: 1, artist: artist.clone(), buyer: artist.clone(),
        price: 100, currency: soroban_sdk::Symbol::new(&env, "xlm"), ledger_sequence: 1,
    };
    ev2.publish(&env);
    
    // Test a subset of events covering all new topics, specifically those that might be long
    assert_eq!(crate::events::LISTING_CREATED, "listing_created");
    assert_eq!(crate::events::PROTOCOL_FEE_COLLECTED, "protocol_fee_collected");
}
`;

fs.appendFileSync('contracts/soroban-marketplace/src/test.rs', testCode);
console.log('Test appended.');
