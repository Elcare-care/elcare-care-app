const fs = require('fs');

let content = fs.readFileSync('indexer/src/parser.ts', 'utf8');

// The original map uses short topics, e.g., 'lst_crtd': 'LISTING_CREATED'
// We will replace the keys with the full string constants

const replacements = {
  "'lst_crtd'": "'listing_created'",
  "'art_sold'": "'artwork_sold'",
  "'lst_cncl'": "'listing_cancelled'",
  "'lst_updt'": "'listing_updated'",
  "'lst_pru'": "'listing_price_updated'",
  "'lst_expd'": "'listing_expired'",
  "'bid_plcd'": "'bid_placed'",
  "'auc_rslv'": "'auction_resolved'",
  "'auc_cncl'": "'auction_cancelled'",
  "'auc_crtd'": "'auction_created'",
  "'auc_ext'": "'auction_extended'",
  "'ofr_made'": "'offer_made'",
  "'ofr_accp'": "'offer_accepted'",
  "'ofr_rjct'": "'offer_rejected'",
  "'ofr_wdrn'": "'offer_withdrawn'",
  "'ofr_rclm'": "'offer_reclaimed'",
  "'roy_paid'": "'royalty_paid'",
  "'fee_cltd'": "'protocol_fee_collected'",
  "'art_rvkd'": "'artist_revoked'",
  "'art_rnst'": "'artist_reinstated'",
  "'adm_prop'": "'admin_transfer_proposed'",
  "'adm_xfrd'": "'admin_transferred'",
  "'ctr_psd'": "'contract_paused'",
  "'ctr_unpsd'": "'contract_unpaused'"
};

for (const [oldKey, newKey] of Object.entries(replacements)) {
  content = content.replace(oldKey, newKey);
}

fs.writeFileSync('indexer/src/parser.ts', content);
console.log('Successfully updated parser.ts');
