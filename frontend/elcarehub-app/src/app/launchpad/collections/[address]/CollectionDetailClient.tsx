"use client";

import { use } from "react";
import Link from "next/link";
import { Navbar } from "@/components/Navbar";
import { useCollectionDetail } from "@/hooks/useLaunchpad";
import { useWalletContext } from "@/context/WalletContext";
import { Loader2, ShieldCheck, User, Percent, Database, Package, ArrowLeft, Plus, Lock, Unlock, Ticket, CheckCircle, XCircle, Clock, AlertTriangle } from "lucide-react";
import { useState, useEffect } from "react";

interface Voucher {
  id: number;
  nonce: string;
  collection: string;
  tokenId: string;
  status: 'Issued' | 'Redeemed' | 'Revoked' | 'Expired';
  createdAtLedger: number;
  updatedAtLedger: number;
}

export default function CollectionDetailClient({ address }: { address: string }) {
  const { metadata, isLoading, error } = useCollectionDetail(address);
  const { publicKey } = useWalletContext();
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [vouchersLoading, setVouchersLoading] = useState(false);
  const [voucherFilter, setVoucherFilter] = useState<'All' | 'Issued' | 'Redeemed' | 'Revoked' | 'Expired'>('All');
  const [showFreezeModal, setShowFreezeModal] = useState(false);
  const [freezing, setFreezing] = useState(false);
  const [showRevokeModal, setShowRevokeModal] = useState(false);
  const [selectedVoucher, setSelectedVoucher] = useState<Voucher | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [collectionPaused, setCollectionPaused] = useState(false);
  const [pausing, setPausing] = useState(false);

  const isCreator = publicKey === metadata?.creator;

  const handleRevokeVoucher = async () => {
    if (!selectedVoucher || !address || !publicKey) return;
    setRevoking(true);
    try {
      const response = await fetch(
        `/api/collections/${address}/vouchers/${selectedVoucher.nonce}/revoke`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } }
      );
      if (response.ok) {
        setVouchers((prev) =>
          prev.map((v) =>
            v.nonce === selectedVoucher.nonce ? { ...v, status: 'Revoked' as const } : v
          )
        );
        setShowRevokeModal(false);
        setSelectedVoucher(null);
      } else {
        alert('Failed to revoke voucher');
      }
    } catch (err) {
      console.error('Failed to revoke voucher:', err);
      alert('Failed to revoke voucher');
    } finally {
      setRevoking(false);
    }
  };

  const handleTogglePause = async () => {
    if (!address || !publicKey) return;
    setPausing(true);
    try {
      const endpoint = collectionPaused ? 'unpause' : 'pause';
      const response = await fetch(`/api/collections/${address}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (response.ok) {
        setCollectionPaused((prev) => !prev);
      } else {
        alert(`Failed to ${endpoint} collection`);
      }
    } catch (err) {
      console.error('Failed to toggle pause:', err);
      alert('Failed to toggle collection pause state');
    } finally {
      setPausing(false);
    }
  };

  const handleFreezeCollection = async () => {
    if (!address || !publicKey) return;
    setFreezing(true);
    try {
      // Call contract freeze_metadata function
      // This would need to be implemented via the wallet SDK
      alert('Freeze functionality requires contract integration - implement via wallet SDK');
      setShowFreezeModal(false);
    } catch (err) {
      console.error('Failed to freeze collection:', err);
      alert('Failed to freeze collection');
    } finally {
      setFreezing(false);
    }
  };

  useEffect(() => {
    const fetchVouchers = async () => {
      if (!address) return;
      setVouchersLoading(true);
      try {
        const statusParam = voucherFilter === 'All' ? '' : `?status=${voucherFilter}`;
        const response = await fetch(`/api/collections/${address}/vouchers${statusParam}`);
        if (response.ok) {
          const data = await response.json();
          setVouchers(data);
        }
      } catch (err) {
        console.error('Failed to fetch vouchers:', err);
      } finally {
        setVouchersLoading(false);
      }
    };
    fetchVouchers();
  }, [address, voucherFilter]);

  return (
    <main className="min-h-screen bg-brand-50/20">
      <Navbar />

      <div className="pt-24 pb-12">
        <div className="max-w-7xl mx-auto px-4">
          <Link
            href="/launchpad/collections"
            className="inline-flex items-center gap-2 text-gray-500 hover:text-brand-500 font-bold transition-colors mb-8 group"
          >
            <div className="p-2 rounded-xl bg-white border border-gray-100 group-hover:border-brand-100 transition-all">
              <ArrowLeft size={20} />
            </div>
            Back to Directory
          </Link>

          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
              <Loader2 size={48} className="animate-spin text-brand-500" />
              <p className="text-gray-500 font-medium font-inter">Fetching collection state...</p>
            </div>
          ) : error ? (
            <div className="rounded-3xl bg-red-50 p-12 text-center border border-red-100">
              <p className="text-red-600 font-bold mb-2">Error loading collection</p>
              <p className="text-red-500 text-sm mb-4">{error}</p>
            </div>
          ) : metadata ? (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              <div className="lg:col-span-2 space-y-8">
                <div className="bg-white rounded-3xl border border-gray-100 p-8 md:p-12 shadow-sm">
                  <div className="flex flex-wrap items-center gap-3 mb-6">
                    <span className="px-4 py-1.5 rounded-full bg-brand-100 text-brand-700 text-xs font-black uppercase tracking-widest">
                      Active Collection
                    </span>
                    <span className="px-4 py-1.5 rounded-full bg-blue-100 text-blue-700 text-xs font-black uppercase tracking-widest">
                      {metadata.symbol || "ERC-1155"}
                    </span>
                    {/* Issue #276: explicit mutable/frozen metadata label */}
                    <span
                      className={`inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-black uppercase tracking-widest ${
                        metadata.isMetadataFrozen
                          ? "bg-gray-900 text-white"
                          : "bg-amber-100 text-amber-700"
                      }`}
                      title={
                        metadata.isMetadataFrozen
                          ? "Metadata is permanently frozen and cannot be changed"
                          : "The creator can still update this collection's metadata"
                      }
                    >
                      {metadata.isMetadataFrozen ? (
                        <>
                          <Lock size={12} /> Metadata Frozen
                        </>
                      ) : (
                        <>
                          <Unlock size={12} /> Metadata Mutable
                        </>
                      )}
                    </span>
                  </div>
                  <h1 className="text-5xl font-display font-black text-gray-900 mb-6 leading-tight">
                    {metadata.name}
                  </h1>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-6 border-t border-gray-50">
                    <div className="flex items-center gap-4">
                      <div className="p-3 rounded-2xl bg-gray-50 text-gray-400">
                        <User size={24} />
                      </div>
                      <div>
                        <p className="text-xs font-bold text-gray-400 uppercase tracking-widest font-inter">Creator</p>
                        <p className="font-mono text-sm font-medium text-gray-900 truncate w-48">
                          {metadata.creator}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="p-3 rounded-2xl bg-gray-50 text-gray-400">
                        <ShieldCheck size={24} />
                      </div>
                      <div>
                        <p className="text-xs font-bold text-gray-400 uppercase tracking-widest font-inter">Contract Address</p>
                        <p className="font-mono text-sm font-medium text-gray-900 truncate w-48">
                          {address}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-white rounded-3xl border border-gray-100 p-8 shadow-sm">
                  <h3 className="text-2xl font-display font-bold text-gray-900 mb-6">Inventory</h3>
                  <div className="flex flex-col items-center justify-center py-12 text-center bg-gray-50/50 rounded-2xl border border-dashed border-gray-200">
                    <div className="p-4 rounded-full bg-white mb-4">
                      <Package size={32} className="text-gray-300" />
                    </div>
                    <p className="text-gray-500 font-inter">No items found in this collection yet.</p>
                  </div>
                </div>

                {isCreator && (
                  <>
                    <div className="bg-white rounded-3xl border border-gray-100 p-8 shadow-sm">
                      <div className="flex items-center justify-between mb-6">
                        <h3 className="text-2xl font-display font-bold text-gray-900">Metadata Freeze</h3>
                        <div className="flex items-center gap-2">
                          <Lock size={20} className="text-gray-400" />
                          <span className="text-sm font-medium text-gray-500">
                            {metadata?.isMetadataFrozen ? 'Frozen' : 'Mutable'}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center justify-between p-4 rounded-xl bg-gray-50 border border-gray-100">
                        <div>
                          <p className="font-bold text-gray-900 mb-1">Freeze Collection Metadata</p>
                          <p className="text-sm text-gray-500">
                            Permanently lock all metadata for this collection. This action is irreversible.
                          </p>
                        </div>
                        {metadata?.isMetadataFrozen ? (
                          <button
                            disabled
                            className="px-4 py-2 rounded-xl bg-gray-200 text-gray-500 font-bold cursor-not-allowed"
                          >
                            Already Frozen
                          </button>
                        ) : (
                          <button
                            onClick={() => setShowFreezeModal(true)}
                            className="px-4 py-2 rounded-xl bg-red-500 text-white font-bold hover:bg-red-600 transition-colors flex items-center gap-2"
                          >
                            <Lock size={16} />
                            Freeze All
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="bg-white rounded-3xl border border-gray-100 p-8 shadow-sm">
                      <div className="flex items-center justify-between mb-6">
                        <h3 className="text-2xl font-display font-bold text-gray-900">Voucher Management</h3>
                        <div className="flex items-center gap-2">
                          <Ticket size={20} className="text-gray-400" />
                          <span className="text-sm font-medium text-gray-500">
                            {vouchers.length} total
                          </span>
                        </div>
                      </div>

                    <div className="flex gap-2 mb-6">
                      {(['All', 'Issued', 'Redeemed', 'Revoked', 'Expired'] as const).map((filter) => (
                        <button
                          key={filter}
                          onClick={() => setVoucherFilter(filter)}
                          className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${
                            voucherFilter === filter
                              ? 'bg-brand-500 text-white'
                              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                          }`}
                        >
                          {filter}
                        </button>
                      ))}
                    </div>

                    {vouchersLoading ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 size={24} className="animate-spin text-brand-500" />
                      </div>
                    ) : vouchers.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-8 text-center bg-gray-50/50 rounded-2xl border border-dashed border-gray-200">
                        <Ticket size={32} className="text-gray-300 mb-2" />
                        <p className="text-gray-500 font-inter text-sm">No vouchers found</p>
                      </div>
                    ) : (
                      <div className="space-y-3 max-h-96 overflow-y-auto">
                        {vouchers.map((voucher) => (
                          <div
                            key={voucher.id}
                            className="flex items-center justify-between p-4 rounded-xl bg-gray-50 border border-gray-100"
                          >
                            <div className="flex items-center gap-3">
                              {voucher.status === 'Redeemed' && (
                                <CheckCircle size={20} className="text-green-500" />
                              )}
                              {voucher.status === 'Revoked' && (
                                <XCircle size={20} className="text-red-500" />
                              )}
                              {voucher.status === 'Expired' && (
                                <Clock size={20} className="text-amber-500" />
                              )}
                              {voucher.status === 'Issued' && (
                                <Ticket size={20} className="text-blue-500" />
                              )}
                              <div>
                                <p className="font-mono text-sm font-medium text-gray-900">
                                  Nonce: {voucher.nonce}
                                </p>
                                <p className="text-xs text-gray-500">
                                  Token ID: {voucher.tokenId}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <span
                                className={`px-3 py-1 rounded-full text-xs font-bold uppercase ${
                                  voucher.status === 'Redeemed'
                                    ? 'bg-green-100 text-green-700'
                                    : voucher.status === 'Revoked'
                                    ? 'bg-red-100 text-red-700'
                                    : voucher.status === 'Expired'
                                    ? 'bg-amber-100 text-amber-700'
                                    : 'bg-blue-100 text-blue-700'
                                }`}
                              >
                                {voucher.status}
                              </span>
                              {isCreator && voucher.status === 'Issued' && (
                                <button
                                  onClick={() => {
                                    setSelectedVoucher(voucher);
                                    setShowRevokeModal(true);
                                  }}
                                  className="px-3 py-1 rounded-xl bg-red-100 text-red-700 text-xs font-bold hover:bg-red-200 transition-colors flex items-center gap-1"
                                >
                                  <XCircle size={12} />
                                  Revoke
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                    <div className="bg-white rounded-3xl border border-gray-100 p-8 shadow-sm">
                      <div className="flex items-center justify-between mb-6">
                        <h3 className="text-2xl font-display font-bold text-gray-900">Collection Pause</h3>
                        <span
                          className={`px-3 py-1 rounded-full text-xs font-bold uppercase ${
                            collectionPaused ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
                          }`}
                        >
                          {collectionPaused ? 'Paused' : 'Active'}
                        </span>
                      </div>

                      <div className="flex items-center justify-between p-4 rounded-xl bg-gray-50 border border-gray-100">
                        <div>
                          <p className="font-bold text-gray-900 mb-1">
                            {collectionPaused ? 'Resume collection trading' : 'Pause collection trading'}
                          </p>
                          <p className="text-sm text-gray-500">
                            {collectionPaused
                              ? 'Unpause to allow listings and purchases for this collection.'
                              : 'Pause to block new listings and purchases for this collection.'}
                          </p>
                        </div>
                        <button
                          onClick={handleTogglePause}
                          disabled={pausing}
                          className={`px-4 py-2 rounded-xl font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 ${
                            collectionPaused
                              ? 'bg-green-500 text-white hover:bg-green-600'
                              : 'bg-amber-500 text-white hover:bg-amber-600'
                          }`}
                        >
                          {pausing ? (
                            <Loader2 size={16} className="animate-spin" />
                          ) : collectionPaused ? (
                            <Unlock size={16} />
                          ) : (
                            <Lock size={16} />
                          )}
                          {collectionPaused ? 'Unpause' : 'Pause'}
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>

              <div className="space-y-6">
                <div className="bg-white rounded-3xl border border-gray-100 p-8 shadow-sm">
                  <h3 className="text-xl font-display font-bold text-gray-900 mb-6">Collection Stats</h3>
                  <div className="space-y-6">
                    <div className="flex justify-between items-center">
                      <div className="flex items-center gap-3 text-gray-500">
                        <Database size={20} />
                        <span className="font-inter font-medium">Supply</span>
                      </div>
                      <span className="font-display font-bold text-gray-900">
                        {metadata.totalSupply} / {metadata.maxSupply === 0 ? "∞" : metadata.maxSupply}
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <div className="flex items-center gap-3 text-gray-500">
                        <Percent size={20} />
                        <span className="font-inter font-medium">Royalty</span>
                      </div>
                      <span className="font-display font-bold text-gray-900">
                        {(metadata.royaltyBps / 100).toFixed(1)}%
                      </span>
                    </div>
                  </div>

                  <div className="mt-10 pt-8 border-t border-gray-50 space-y-3">
                    <p className="text-sm font-bold text-gray-400 uppercase tracking-widest font-inter">Mint &amp; redeem</p>
                    <Link
                      href={`/launchpad/collections/${address}/mint`}
                      className="w-full flex items-center justify-center gap-2 rounded-2xl bg-brand-500 py-4 text-white font-bold hover:bg-brand-600 transition-all shadow-lg shadow-brand-500/20"
                    >
                      <Plus size={20} />
                      Open mint / redeem
                    </Link>
                    {isCreator && (
                      <p className="text-xs text-gray-500 font-inter text-center">
                        As the creator you can mint on normal collections; lazy collections use signed vouchers.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Revoke Voucher Confirmation Modal */}
      {showRevokeModal && selectedVoucher && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl p-8 max-w-md w-full shadow-2xl">
            <div className="flex items-center gap-3 mb-6">
              <div className="p-3 rounded-full bg-red-100">
                <XCircle size={24} className="text-red-600" />
              </div>
              <h3 className="text-2xl font-display font-bold text-gray-900">Revoke Voucher</h3>
            </div>

            <div className="space-y-4 mb-8">
              <p className="text-gray-600">
                You are about to revoke voucher with nonce{' '}
                <span className="font-mono font-bold">{selectedVoucher.nonce}</span>. The holder
                will no longer be able to redeem it.
              </p>
              <div className="p-4 rounded-xl bg-amber-50 border border-amber-200">
                <p className="text-sm text-amber-800 font-medium">
                  ⚠️ This action cannot be undone. The voucher status will change to Revoked.
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => { setShowRevokeModal(false); setSelectedVoucher(null); }}
                disabled={revoking}
                className="flex-1 px-4 py-3 rounded-xl bg-gray-100 text-gray-700 font-bold hover:bg-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                onClick={handleRevokeVoucher}
                disabled={revoking}
                className="flex-1 px-4 py-3 rounded-xl bg-red-500 text-white font-bold hover:bg-red-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {revoking ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Revoking...
                  </>
                ) : (
                  <>
                    <XCircle size={16} />
                    Confirm Revoke
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Freeze Confirmation Modal */}
      {showFreezeModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl p-8 max-w-md w-full shadow-2xl">
            <div className="flex items-center gap-3 mb-6">
              <div className="p-3 rounded-full bg-red-100">
                <AlertTriangle size={24} className="text-red-600" />
              </div>
              <h3 className="text-2xl font-display font-bold text-gray-900">Freeze Collection Metadata</h3>
            </div>

            <div className="space-y-4 mb-8">
              <p className="text-gray-600">
                You are about to permanently freeze all metadata for this collection. This action is <strong>irreversible</strong>.
              </p>
              <div className="p-4 rounded-xl bg-amber-50 border border-amber-200">
                <p className="text-sm text-amber-800 font-medium">
                  ⚠️ Once frozen, neither you nor anyone else will be able to update token URIs or collection metadata.
                </p>
              </div>
              <p className="text-sm text-gray-500">
                This provides collectors with a guarantee that the artwork they purchased will never be altered.
              </p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowFreezeModal(false)}
                disabled={freezing}
                className="flex-1 px-4 py-3 rounded-xl bg-gray-100 text-gray-700 font-bold hover:bg-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                onClick={handleFreezeCollection}
                disabled={freezing}
                className="flex-1 px-4 py-3 rounded-xl bg-red-500 text-white font-bold hover:bg-red-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {freezing ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Freezing...
                  </>
                ) : (
                  <>
                    <Lock size={16} />
                    Confirm Freeze
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
