"use client";

import { useState } from "react";
import {
  X,
  CreditCard,
  Wallet,
  Loader2,
} from "lucide-react";
import { Listing, stroopsToXlm } from "@/lib/contract";
import posthog from "posthog-js";

interface CheckoutModalProps {
  isOpen: boolean;
  onClose: () => void;
  listing: Listing;
  onCryptoPurchase: () => Promise<boolean>;
  onPurchased?: () => void;
  isBuyingCrypto: boolean;
}

export function CheckoutModal({
  isOpen,
  onClose,
  listing,
  onCryptoPurchase,
  onPurchased,
  isBuyingCrypto,
}: CheckoutModalProps) {
  const [method, setMethod] = useState<"crypto" | "fiat">("crypto");

  if (!isOpen) return null;

  const priceXlm = Number(stroopsToXlm(listing.price));
  const estimatedFiat = (priceXlm * 0.12).toFixed(2);

  const handleCryptoPurchase = async () => {
    const success = await onCryptoPurchase();
    if (success) {
      posthog.capture("Purchase Successful", {
        listing_id: listing.listing_id,
        price_xlm: priceXlm,
        method: "crypto",
      });
      onPurchased?.();
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-midnight-950/80 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative w-full max-w-md overflow-hidden rounded-3xl bg-white shadow-2xl animate-scale-in">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 p-6">
          <h2 className="font-display text-xl font-bold text-gray-900">
            Checkout
          </h2>
          <button
            onClick={onClose}
            className="rounded-full p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-900 transition"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          <div className="mb-6 flex justify-between rounded-2xl bg-gray-50 p-4">
            <div>
              <p className="text-sm text-gray-500">Total Price</p>
              <p className="font-display text-2xl font-bold text-gray-900">
                {priceXlm} XLM
              </p>
            </div>
            <div className="text-right">
              <p className="text-sm text-gray-500">Estimated</p>
              <p className="font-display text-xl font-bold text-brand-500">
                ~${estimatedFiat}
              </p>
            </div>
          </div>

          {/* Payment method selector */}
          <div className="space-y-4">
            <h3 className="text-sm font-bold uppercase tracking-wider text-gray-500">
              Select Payment Method
            </h3>

            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setMethod("crypto")}
                className={`flex flex-col items-center gap-3 rounded-2xl border-2 p-4 transition-all ${method === "crypto" ? "border-brand-500 bg-brand-50 text-brand-600" : "border-gray-100 hover:border-gray-200 text-gray-600"}`}
              >
                <Wallet size={24} />
                <span className="text-sm font-semibold">Crypto</span>
              </button>

              {/* Fiat payment — coming soon */}
              <div className="relative flex flex-col items-center gap-3 rounded-2xl border-2 border-gray-100 p-4 text-gray-400 cursor-not-allowed select-none opacity-60">
                <CreditCard size={24} />
                <span className="text-sm font-semibold">Credit Card</span>
                <span className="absolute -top-2 right-2 rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-orange-600">
                  Coming Soon
                </span>
              </div>
            </div>

            <button
              onClick={handleCryptoPurchase}
              disabled={isBuyingCrypto}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-500 py-4 font-bold text-white shadow-lg shadow-brand-500/20 hover:bg-brand-600 transition-all disabled:opacity-50"
            >
              {isBuyingCrypto ? (
                <>
                  <Loader2 className="animate-spin" size={18} /> Processing...
                </>
              ) : (
                `Pay ${priceXlm} XLM`
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
