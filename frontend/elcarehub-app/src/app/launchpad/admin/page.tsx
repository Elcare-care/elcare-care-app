// ─────────────────────────────────────────────────────────────
// app/launchpad/admin/page.tsx — Launchpad Admin Dashboard
// ─────────────────────────────────────────────────────────────

"use client";

import { useState } from "react";
import { useWallet } from "@/hooks/useWallet";
import { useLaunchpadAdminCheck, useLaunchpadAdminStats, useLaunchpadAdminActions } from "@/hooks/useLaunchpadAdmin";
import { useLaunchpadCollections } from "@/hooks/useLaunchpad";
import { useAdminSession } from "@/hooks/useAdminSession";
import { AdminConfirmationModal } from "@/components/AdminConfirmationModal";
import {
  Shield,
  Settings,
  TrendingUp,
  Users,
  DollarSign,
  Edit,
  Save,
  X,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Palette,
  BarChart3,
  Crown,
  Zap,
  KeyRound,
  History
} from "lucide-react";

export default function LaunchpadAdminPage() {
  const { publicKey } = useWallet();
  const { isAdmin, isLoading: isCheckingAdmin } = useLaunchpadAdminCheck(publicKey);
  const { stats, isLoading: isLoadingStats, refresh: refreshStats } = useLaunchpadAdminStats();
  const { transferAdmin, updateFee, updateWasm, upgradeCollectionForAddress, isProcessing, error: actionError } = useLaunchpadAdminActions(publicKey);
  const { collections } = useLaunchpadCollections();
  const { isAuthenticated, authenticate, logout, sessionExpiresIn } = useAdminSession();

  // Local state for admin actions
  const [newAdminAddress, setNewAdminAddress] = useState("");
  const [newFeeReceiver, setNewFeeReceiver] = useState("");
  const [newFeeBps, setNewFeeBps] = useState("");
  const [wasmKind, setWasmKind] = useState<"Normal721" | "Normal1155" | "LazyMint721" | "LazyMint1155">("Normal721");
  const [wasmHashInput, setWasmHashInput] = useState("");
  const [collectionAddressInput, setCollectionAddressInput] = useState("");
  const [wasmStatus, setWasmStatus] = useState<string | null>(null);

  // Local state for editing
  const [isEditingAdmin, setIsEditingAdmin] = useState(false);
  const [isEditingFee, setIsEditingFee] = useState(false);

  // Confirmation Modal state
  const [confirmConfig, setConfirmConfig] = useState<{
    isOpen: boolean;
    title: string;
    actionDescription: string;
    consequences: string[];
    onConfirm: () => void;
    variant: "danger" | "warning" | "info";
  }>({
    isOpen: false,
    title: "",
    actionDescription: "",
    consequences: [],
    onConfirm: () => { },
    variant: "danger"
  });

  const handleTransferAdmin = async () => {
    if (!newAdminAddress.trim()) return;

    setConfirmConfig({
      isOpen: true,
      title: "Transfer Admin Rights",
      actionDescription: `Transferring administrative control to ${newAdminAddress}.`,
      consequences: [
        "You will lose all administrative permissions immediately.",
        "The new admin will have full control over launchpad settings.",
        "This action is irreversible unless the new admin transfers it back.",
        "Requires a blockchain transaction and signature."
      ],
      variant: "danger",
      onConfirm: async () => {
        const success = await transferAdmin(newAdminAddress.trim());
        if (success) {
          setIsEditingAdmin(false);
          setNewAdminAddress("");
          setConfirmConfig(prev => ({ ...prev, isOpen: false }));
          // Refresh admin check
          window.location.reload();
        }
      }
    });
  };

  const handleUpdateFee = async () => {
    if (!newFeeReceiver.trim() || !newFeeBps.trim()) return;
    const feeBps = parseInt(newFeeBps.trim());
    if (isNaN(feeBps) || feeBps < 0 || feeBps > 10000) return; // Max 100%

    setConfirmConfig({
      isOpen: true,
      title: "Update Platform Fee",
      actionDescription: `Updating platform fee to ${feeBps / 100}% and setting receiver to ${newFeeReceiver}.`,
      consequences: [
        "All future collection deployments will use this new fee structure.",
        "Existing collections are not affected.",
        "Fees will be sent to the specified receiver address.",
        "Ensure the receiver address is correct to avoid loss of funds."
      ],
      variant: "warning",
      onConfirm: async () => {
        const success = await updateFee(newFeeReceiver.trim(), feeBps);
        if (success) {
          setIsEditingFee(false);
          setNewFeeReceiver("");
          setNewFeeBps("");
          setConfirmConfig(prev => ({ ...prev, isOpen: false }));
          refreshStats();
        }
      }
    });
  };

  const handleUpdateWasm = async () => {
    if (!wasmHashInput.trim()) return;
    setConfirmConfig({
      isOpen: true,
      title: "Update Collection WASM",
      actionDescription: `Updating the ${wasmKind} contract WASM to ${wasmHashInput.trim()}.`,
      consequences: [
        "Future deployments of this collection kind will use the new executable.",
        "Existing deployed collections remain unchanged until you upgrade them.",
        "Double-check the hash before submitting the transaction."
      ],
      variant: "warning",
      onConfirm: async () => {
        const success = await updateWasm(wasmKind, wasmHashInput.trim());
        if (success) {
          setWasmStatus(`Updated ${wasmKind} WASM successfully.`);
          setWasmHashInput("");
          setConfirmConfig(prev => ({ ...prev, isOpen: false }));
        } else {
          setWasmStatus(actionError ?? "Unable to update WASM.");
          setConfirmConfig(prev => ({ ...prev, isOpen: false }));
        }
      }
    });
  };

  const handleUpgradeCollection = async () => {
    if (!collectionAddressInput.trim()) return;
    setConfirmConfig({
      isOpen: true,
      title: "Upgrade Collection",
      actionDescription: `Upgrading collection ${collectionAddressInput.trim()} to the current launchpad WASM.`,
      consequences: [
        "This operation re-points the deployed collection contract to the active WASM for its kind.",
        "Only proceed if the collection address is correct."
      ],
      variant: "warning",
      onConfirm: async () => {
        const success = await upgradeCollectionForAddress(collectionAddressInput.trim());
        if (success) {
          setWasmStatus(`Upgraded ${collectionAddressInput.trim()} successfully.`);
          setCollectionAddressInput("");
          setConfirmConfig(prev => ({ ...prev, isOpen: false }));
        } else {
          setWasmStatus(actionError ?? "Unable to upgrade collection.");
          setConfirmConfig(prev => ({ ...prev, isOpen: false }));
        }
      }
    });
  };

  if (isCheckingAdmin) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <Loader2 size={48} className="animate-spin text-brand-500 mx-auto mb-4" />
          <p className="text-gray-500 font-medium">Checking admin access...</p>
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center max-w-md">
          <Shield size={64} className="text-gray-300 mx-auto mb-6" />
          <h1 className="text-2xl font-display font-bold text-gray-900 mb-4">
            Admin Access Required
          </h1>
          <p className="text-gray-500 font-inter">
            You need to be the launchpad admin to access this page. Make sure you&apos;re connected with the correct wallet.
          </p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-4 text-center">
        <div className="mb-6 rounded-full bg-brand-100 p-6">
          <Crown className="h-12 w-12 text-brand-600" />
        </div>
        <h1 className="font-display text-4xl font-bold tracking-tight text-gray-900 sm:text-5xl">
          Launchpad Admin Session
        </h1>
        <p className="mt-4 max-w-lg text-lg text-gray-600 mb-8 font-inter">
          Secure access is required for sensitive launchpad operations.
          Please authenticate to start your 15-minute administrative session.
        </p>
        <button
          onClick={authenticate}
          className="flex items-center gap-2 rounded-2xl bg-brand-600 px-8 py-4 text-lg font-bold text-white shadow-lg shadow-brand-200 transition-all hover:bg-brand-700 active:scale-95"
        >
          <KeyRound className="h-6 w-6" />
          Authenticate Session
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-brand-100">
                <Crown size={24} className="text-brand-600" />
              </div>
              <div>
                <h1 className="text-2xl font-display font-bold text-gray-900">
                  Launchpad Admin Dashboard
                </h1>
                <div className="flex items-center gap-2 mt-1">
                  <p className="text-sm text-gray-500 font-inter">
                    Manage launchpad settings and monitoring
                  </p>
                  <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-700">
                    <History className="h-3 w-3" />
                    {Math.floor(sessionExpiresIn / 60000)}m
                  </span>
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={logout}
                className="px-4 py-2 text-sm font-semibold text-red-600 bg-red-50 rounded-lg hover:bg-red-100 transition-colors"
              >
                Logout
              </button>
              <button
                onClick={() => { refreshStats(); }}
                className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
              >
                <Loader2 size={16} className={isLoadingStats ? 'animate-spin' : ''} />
                Refresh
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm mb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-100 text-brand-600">
              <Zap size={20} />
            </div>
            <div>
              <h2 className="text-lg font-display font-semibold text-gray-900">Collection WASM Management</h2>
              <p className="text-sm text-gray-500">Rotate the executable for a collection kind or upgrade an existing deployment.</p>
            </div>
          </div>

          {wasmStatus && (
            <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
              {wasmStatus}
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-xl border border-gray-200 p-4">
              <label className="mb-2 block text-sm font-semibold text-gray-700">Collection kind</label>
              <select
                value={wasmKind}
                onChange={(e) => setWasmKind(e.target.value as any)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700"
              >
                <option value="Normal721">Normal721</option>
                <option value="Normal1155">Normal1155</option>
                <option value="LazyMint721">LazyMint721</option>
                <option value="LazyMint1155">LazyMint1155</option>
              </select>
              <label className="mt-4 mb-2 block text-sm font-semibold text-gray-700">New WASM hash (32-byte hex)</label>
              <input
                value={wasmHashInput}
                onChange={(e) => setWasmHashInput(e.target.value)}
                placeholder="66..."
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700"
              />
              <button
                onClick={handleUpdateWasm}
                disabled={isProcessing}
                className="mt-4 inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-brand-300"
              >
                {isProcessing ? <Loader2 size={16} className="animate-spin" /> : <Zap size={16} />}
                Update WASM
              </button>
            </div>

            <div className="rounded-xl border border-gray-200 p-4">
              <label className="mb-2 block text-sm font-semibold text-gray-700">Collection address</label>
              <input
                value={collectionAddressInput}
                onChange={(e) => setCollectionAddressInput(e.target.value)}
                placeholder="G..."
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700"
              />
              <button
                onClick={handleUpgradeCollection}
                disabled={isProcessing}
                className="mt-4 inline-flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-400"
              >
                {isProcessing ? <Loader2 size={16} className="animate-spin" /> : <Settings size={16} />}
                Upgrade Collection
              </button>
            </div>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <div className="bg-white rounded-xl p-6 border border-gray-200">
            <div className="flex items-center gap-4">
              <div className="flex items-center justify-center w-12 h-12 rounded-lg bg-brand-100">
                <Palette size={24} className="text-brand-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-500">Total Collections</p>
                <p className="text-2xl font-display font-bold text-gray-900">
                  {isLoadingStats ? "..." : stats?.totalCollections || 0}
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl p-6 border border-gray-200">
            <div className="flex items-center gap-4">
              <div className="flex items-center justify-center w-12 h-12 rounded-lg bg-mint-100">
                <Users size={24} className="text-mint-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-500">Active Creators</p>
                <p className="text-2xl font-display font-bold text-gray-900">
                  {new Set(collections.map(c => c.creator)).size}
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl p-6 border border-gray-200">
            <div className="flex items-center gap-4">
              <div className="flex items-center justify-center w-12 h-12 rounded-lg bg-terracotta-100">
                <DollarSign size={24} className="text-terracotta-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-500">Platform Fee</p>
                <p className="text-2xl font-display font-bold text-gray-900">
                  {isLoadingStats ? "..." : `${(stats?.platformFeeBps || 0) / 100}%`}
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl p-6 border border-gray-200">
            <div className="flex items-center gap-4">
              <div className="flex items-center justify-center w-12 h-12 rounded-lg bg-amber-100">
                <Zap size={24} className="text-amber-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-500">Collection Types</p>
                <p className="text-2xl font-display font-bold text-gray-900">4</p>
              </div>
            </div>
          </div>
        </div>

        {/* Admin Actions */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Admin Transfer */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center gap-3 mb-6">
              <Shield size={24} className="text-brand-600" />
              <h2 className="text-lg font-display font-bold text-gray-900">
                Admin Management
              </h2>
            </div>

            {!isEditingAdmin ? (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Current Admin
                  </label>
                  <p className="text-sm font-mono text-gray-900 bg-gray-50 px-3 py-2 rounded-lg">
                    {publicKey}
                  </p>
                </div>
                <button
                  onClick={() => setIsEditingAdmin(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-white rounded-lg hover:bg-brand-600 transition-colors"
                >
                  <Edit size={16} />
                  Transfer Admin
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    New Admin Address
                  </label>
                  <input
                    type="text"
                    value={newAdminAddress}
                    onChange={(e) => setNewAdminAddress(e.target.value)}
                    placeholder="G..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:border-brand-500 focus:outline-none"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleTransferAdmin}
                    disabled={isProcessing || !newAdminAddress.trim()}
                    className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-white rounded-lg hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {isProcessing ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                    Transfer
                  </button>
                  <button
                    onClick={() => {
                      setIsEditingAdmin(false);
                      setNewAdminAddress("");
                    }}
                    className="flex items-center gap-2 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                  >
                    <X size={16} />
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Fee Management */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center gap-3 mb-6">
              <DollarSign size={24} className="text-terracotta-600" />
              <h2 className="text-lg font-display font-bold text-gray-900">
                Platform Fee Management
              </h2>
            </div>

            {!isEditingFee ? (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Current Fee
                  </label>
                  <p className="text-sm text-gray-900">
                    {(stats?.platformFeeBps || 0) / 100}% per deployment
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Fee Receiver
                  </label>
                  <p className="text-sm font-mono text-gray-900 bg-gray-50 px-3 py-2 rounded-lg break-all">
                    {stats?.platformFeeReceiver}
                  </p>
                </div>
                <button
                  onClick={() => setIsEditingFee(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-terracotta-500 text-white rounded-lg hover:bg-terracotta-600 transition-colors"
                >
                  <Edit size={16} />
                  Update Fee
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Fee Receiver Address
                  </label>
                  <input
                    type="text"
                    value={newFeeReceiver}
                    onChange={(e) => setNewFeeReceiver(e.target.value)}
                    placeholder="G..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:border-terracotta-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Fee BPS (1 = 0.01%)
                  </label>
                  <input
                    type="number"
                    value={newFeeBps}
                    onChange={(e) => setNewFeeBps(e.target.value)}
                    placeholder="500"
                    min="0"
                    max="10000"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:border-terracotta-500 focus:outline-none"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    500 = 5%, 1000 = 10%, max 10000 = 100%
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleUpdateFee}
                    disabled={isProcessing || !newFeeReceiver.trim() || !newFeeBps.trim()}
                    className="flex items-center gap-2 px-4 py-2 bg-terracotta-500 text-white rounded-lg hover:bg-terracotta-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {isProcessing ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                    Update
                  </button>
                  <button
                    onClick={() => {
                      setIsEditingFee(false);
                      setNewFeeReceiver("");
                      setNewFeeBps("");
                    }}
                    className="flex items-center gap-2 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                  >
                    <X size={16} />
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Error Display */}
        {actionError && (
          <div className="mt-6 bg-red-50 border border-red-200 rounded-xl p-4">
            <div className="flex items-center gap-3">
              <AlertCircle size={20} className="text-red-500" />
              <p className="text-red-700 font-medium">{actionError}</p>
            </div>
          </div>
        )}

        {/* Recent Collections */}
        <div className="mt-8 bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center gap-3 mb-6">
            <BarChart3 size={24} className="text-brand-600" />
            <h2 className="text-lg font-display font-bold text-gray-900">
              Recent Collections
            </h2>
          </div>

          <div className="space-y-4">
            {collections.slice(0, 5).map((collection) => (
              <div key={collection.address} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                <div className="flex items-center gap-4">
                  <div className={`px-3 py-1 rounded-full text-xs font-bold ${
                    collection.kind.startsWith('Lazy') ? 'bg-amber-100 text-amber-700' : 'bg-brand-100 text-brand-700'
                  }`}>
                    {collection.kind}
                  </div>
                  <div>
                    <p className="font-mono text-sm text-gray-900">
                      {collection.address.slice(0, 12)}...{collection.address.slice(-8)}
                    </p>
                    <p className="text-xs text-gray-500">
                      Creator: {collection.creator.slice(0, 8)}...{collection.creator.slice(-6)}
                    </p>
                  </div>
                </div>
                <CheckCircle2 size={20} className="text-green-500" />
              </div>
            ))}
            {collections.length === 0 && (
              <p className="text-gray-500 text-center py-8">No collections deployed yet.</p>
            )}
          </div>
        </div>
      </div>

      <AdminConfirmationModal
        isOpen={confirmConfig.isOpen}
        onClose={() => setConfirmConfig(prev => ({ ...prev, isOpen: false }))}
        onConfirm={confirmConfig.onConfirm}
        title={confirmConfig.title}
        actionDescription={confirmConfig.actionDescription}
        consequences={confirmConfig.consequences}
        variant={confirmConfig.variant}
        isProcessing={isProcessing}
      />
    </div>
  );
}