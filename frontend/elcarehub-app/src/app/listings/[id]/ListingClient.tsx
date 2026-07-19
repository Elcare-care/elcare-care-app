// ─────────────────────────────────────────────────────────────
// app/listings/[id]/ListingClient.tsx — Premium NFT listing detail page
// ─────────────────────────────────────────────────────────────

"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import {
    stroopsToXlm,
    Listing,
    Auction,
    getListing,
    getAuction,
} from "@/lib/contract";
import { fetchMetadata, cidToGatewayUrl, ArtworkMetadata } from "@/lib/ipfs";
import { useWalletContext } from "@/context/WalletContext";
import { useBuyArtwork } from "@/hooks/useMarketplace";
import { usePlaceBid } from "@/hooks/usePlaceBid";
import { useListingOffers, useMakeOffer } from "@/hooks/useOffers";
import { useListingActivity } from "@/hooks/useUserActivity";
import { useListingHistory } from "@/hooks/useListingHistory";
import { getListingPriceHistory, PriceHistoryPoint } from "@/lib/indexer";
import { ProvenanceTimeline } from "@/components/ProvenanceTimeline";
import { OfferPanel } from "@/components/OfferPanel";
import { PriceHistoryChart } from "@/components/PriceHistoryChart";
import { SocialShare } from "@/components/SocialShare";
import { GuardButton } from "@/components/WalletGuard";
import {
    ArrowLeft,
    ExternalLink,
    ShoppingCart,
    User,
    Calendar,
    Hash,
    Clock,
    Gavel,
    History,
    ShieldCheck,
    CheckCircle2,
    AlertCircle,
    TrendingUp,
} from "lucide-react";

interface ListingClientProps {
    id: string;
}

// ── usePriceHistory inline hook ────────────────────────────────────────────────

function usePriceHistory(listingId: number | null) {
    const [points, setPoints] = useState<PriceHistoryPoint[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (listingId === null) return;
        let cancelled = false;
        setIsLoading(true);
        setError(null);
        getListingPriceHistory(listingId)
            .then((data) => { if (!cancelled) setPoints(data); })
            .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load price history"); })
            .finally(() => { if (!cancelled) setIsLoading(false); });
        return () => { cancelled = true; };
    }, [listingId]);

    return { points, isLoading, error };
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function ListingDetailPage({ id }: ListingClientProps) {
    const router = useRouter();
    const { publicKey } = useWalletContext();

    // State
    const [listing, setListing] = useState<Listing | null>(null);
    const [auction, setAuction] = useState<Auction | null>(null);
    const [metadata, setMetadata] = useState<ArtworkMetadata | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<'details' | 'history' | 'offers'>('details');

    // Hooks
    const { buy, isBuying, error: buyError } = useBuyArtwork(publicKey);
    const { bid, isBidding, error: bidError } = usePlaceBid(publicKey);
    const { offers, isLoading: isLoadingOffers, refresh: refreshOffers } = useListingOffers(id ? Number(id) : null);
    // Kept for existing consumers / mocks
    useListingActivity(id ? Number(id) : null);
    const {
        events: historyEvents,
        isLoading: isLoadingHistory,
        isLoadingMore,
        error: historyError,
        hasMore,
        loadMore,
    } = useListingHistory(id ? Number(id) : null);

    // Price history (for sparkline chart)
    const listingIdNum = id ? Number(id) : null;
    const { points: pricePoints, isLoading: isPriceLoading, error: priceError } = usePriceHistory(listingIdNum);

    // Make Offer Hook
    const { make: makeOffer, isOffering, error: offerError } = useMakeOffer(publicKey);

    const handleMakeOffer = useCallback(
        async (amount: number, tokenAddress: string, _expiryTs?: number): Promise<boolean> => {
            if (!listing) return false;
            const ok = await makeOffer(listing.listing_id, amount, tokenAddress);
            if (ok) refreshOffers();
            return ok;
        },
        [listing, makeOffer, refreshOffers]
    );

    // Bid state
    const [bidAmount, setBidAmount] = useState("");

    useEffect(() => {
        const loadData = async () => {
            if (!id) return;
            setIsLoading(true);
            setError(null);
            try {
                let l: Listing | null = null;
                let a: Auction | null = null;

                try { l = await getListing(Number(id)); setListing(l); } catch {}
                try { a = await getAuction(Number(id)); setAuction(a); } catch {}

                if (!l && !a) throw new Error("Artwork not found");

                const cid = l?.metadata_cid || a?.metadata_cid;
                if (cid) {
                    try {
                        const m = await fetchMetadata(cid);
                        setMetadata(m);
                    } catch {}
                }
            } catch (err: any) {
                setError(err.message || "Failed to load artwork details");
            } finally {
                setIsLoading(false);
            }
        };
        loadData();
    }, [id]);

    const handleBuy = async () => {
        if (!listing) return;
        const success = await buy(listing.listing_id);
        if (success) {
            const updated = await getListing(listing.listing_id);
            setListing(updated);
        }
    };

    const handleBid = async () => {
        if (!auction || !bidAmount) return;
        const success = await bid(auction.auction_id, Number(bidAmount));
        if (success) {
            const updated = await getAuction(auction.auction_id);
            setAuction(updated);
            setBidAmount("");
        }
    };

    const handleProvenance = () => {
        setActiveTab("history");
        document.getElementById("listing-tabs")?.scrollIntoView({ behavior: "smooth" });
    };

    if (isLoading) {
        return (
            <div className="flex flex-col items-center justify-center py-40 gap-4">
                <div className="h-16 w-16 animate-spin rounded-full border-4 border-brand-200 border-t-brand-500" />
                <p className="text-brand-300 font-display italic">Summoning artwork from the savanna...</p>
            </div>
        );
    }

    if (error || (!listing && !auction)) {
        return (
            <div className="py-32 flex flex-col items-center text-center">
                <div className="w-20 h-20 bg-terracotta-500/10 rounded-full flex items-center justify-center mb-6">
                    <AlertCircle size={40} className="text-terracotta-500" />
                </div>
                <h2 className="text-2xl font-display font-bold text-white mb-2">Artwork Not Found</h2>
                <p className="text-white/60 mb-8 max-w-md">{error ?? "The listing you are looking for does not exist or has been removed."}</p>
                <button
                    onClick={() => router.push('/')}
                    className="px-8 py-3 rounded-xl bg-brand-500 text-white font-bold hover:bg-brand-600 transition-all shadow-lg shadow-brand-500/20"
                >
                    Return to Marketplace
                </button>
            </div>
        );
    }

    const imageUrl = metadata?.image ? cidToGatewayUrl(metadata.image) : null;
    const artist = listing?.artist || auction?.creator;
    const isOwn = publicKey === artist;
    const status = listing?.status || auction?.status;
    const isActive = status === "Active";

    const priceDisplay = listing
        ? stroopsToXlm(listing.price)
        : auction
        ? stroopsToXlm(auction.highest_bid || auction.reserve_price)
        : "0";

    const royaltyPercent = "0.0";

    // Listing URL for sharing
    const listingUrl =
        typeof window !== "undefined"
            ? window.location.href
            : `https://elcarehub.art/listings/${id}`;

    return (
        <div className="min-h-screen bg-midnight-950 text-white pb-20 pt-24 px-4 sm:px-6 lg:px-8">

            <div className="grid gap-12 lg:grid-cols-2 lg:items-start">
                {/* LEFT COLUMN: Media, Tabs & Description */}
                <div className="space-y-8 animate-fade-in-left">
                    {/* Main Artwork Frame */}
                    <div className="relative aspect-square overflow-hidden rounded-[2.5rem] bg-midnight-900 border border-white/5 shadow-2xl group">
                        {imageUrl ? (
                            <Image
                                src={imageUrl}
                                alt={metadata?.title ?? "Artwork"}
                                fill
                                className="object-cover transition-transform duration-700 group-hover:scale-105"
                                priority
                                unoptimized
                            />
                        ) : (
                            <div className="flex h-full flex-col items-center justify-center text-8xl opacity-20">
                                🎨
                                <span className="text-lg font-display mt-4 italic">No media available</span>
                            </div>
                        )}

                        {/* Status Badge */}
                        <div className={`absolute top-6 right-6 px-4 py-1.5 rounded-full text-xs font-bold tracking-widest uppercase backdrop-blur-md shadow-xl border ${
                            status === "Active" ? "bg-mint-500/20 text-mint-400 border-mint-500/30" :
                            status === "Sold" || status === "Finalized" ? "bg-brand-500/20 text-brand-400 border-brand-500/30" :
                            "bg-terracotta-500/20 text-terracotta-400 border-terracotta-500/30"
                        }`}>
                            {status}
                        </div>

                        {/* Type Badge */}
                        <div className="absolute top-6 left-6 px-4 py-1.5 rounded-full text-xs font-bold bg-white/10 backdrop-blur-md text-white border border-white/20">
                            {listing ? "Fixed Price" : "Timed Auction"}
                        </div>
                    </div>

                    {/* Description & Metadata Tabs */}
                    <div id="listing-tabs" className="rounded-3xl bg-white/5 border border-white/5 p-6 md:p-8 backdrop-blur-sm">
                        <div className="flex gap-6 md:gap-8 border-b border-white/5 mb-6 md:mb-8">
                            {(['details', 'history', 'offers'] as const).map((tab) => (
                                <button
                                    key={tab}
                                    onClick={() => setActiveTab(tab)}
                                    data-testid={`tab-${tab}`}
                                    className={`pb-4 text-sm font-bold uppercase tracking-wider transition-all relative ${
                                        activeTab === tab ? "text-brand-400" : "text-white/40 hover:text-white"
                                    }`}
                                >
                                    {tab}
                                    {activeTab === tab && (
                                        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand-400 animate-slide-up" />
                                    )}
                                </button>
                            ))}
                        </div>

                        {/* ── Details tab ─────────────────────────────────── */}
                        {activeTab === 'details' && (
                            <div className="space-y-6 animate-fade-in">
                                <p className="text-white/70 leading-relaxed text-lg italic">
                                    {metadata?.description || "No description provided by the artist."}
                                </p>

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pt-4">
                                    <div className="space-y-1">
                                        <span className="text-[10px] uppercase tracking-widest text-white/30 font-bold">Artist</span>
                                        <div className="flex items-center gap-2 group cursor-pointer">
                                            <div className="w-8 h-8 rounded-full bg-brand-500/10 flex items-center justify-center text-brand-400 group-hover:bg-brand-500 group-hover:text-white transition-all">
                                                <User size={14} />
                                            </div>
                                            <span className="font-mono text-sm group-hover:text-brand-400 transition-all">
                                                {artist?.slice(0, 6)}…{artist?.slice(-4)}
                                            </span>
                                        </div>
                                    </div>

                                    {metadata?.year && (
                                        <div className="space-y-1">
                                            <span className="text-[10px] uppercase tracking-widest text-white/30 font-bold">Year Created</span>
                                            <div className="flex items-center gap-2">
                                                <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-white/60">
                                                    <Calendar size={14} />
                                                </div>
                                                <span className="text-sm font-medium">{metadata.year}</span>
                                            </div>
                                        </div>
                                    )}

                                    <div className="space-y-1">
                                        <span className="text-[10px] uppercase tracking-widest text-white/30 font-bold">Metadata</span>
                                        <div className="flex items-center gap-2">
                                            <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-white/60">
                                                <Hash size={14} />
                                            </div>
                                            <a
                                                href={`https://ipfs.io/ipfs/${listing?.metadata_cid || auction?.metadata_cid}`}
                                                target="_blank"
                                                className="text-sm font-mono text-brand-400 hover:underline flex items-center gap-1"
                                            >
                                                IPFS Link <ExternalLink size={10} />
                                            </a>
                                        </div>
                                    </div>

                                    <div className="space-y-1">
                                        <span className="text-[10px] uppercase tracking-widest text-white/30 font-bold">Royalty</span>
                                        <div className="flex items-center gap-2">
                                            <div className="w-8 h-8 rounded-full bg-mint-500/10 flex items-center justify-center text-mint-400 font-bold text-[10px]">
                                                %
                                            </div>
                                            <span className="text-sm font-medium">{royaltyPercent}% to Creator</span>
                                        </div>
                                    </div>
                                </div>

                                {/* Price History Chart */}
                                <PriceHistoryChart
                                    points={pricePoints}
                                    isLoading={isPriceLoading}
                                    error={priceError}
                                    className="mt-6"
                                />
                            </div>
                        )}

                        {/* ── History tab ─────────────────────────────────── */}
                        {activeTab === 'history' && (
                            <div className="animate-fade-in max-h-[28rem] overflow-y-auto pr-2 custom-scrollbar">
                                <ProvenanceTimeline
                                    events={historyEvents}
                                    isLoading={isLoadingHistory}
                                    isLoadingMore={isLoadingMore}
                                    error={historyError}
                                    hasMore={hasMore}
                                    onLoadMore={loadMore}
                                />
                            </div>
                        )}

                        {/* ── Offers tab ───────────────────────────────────── */}
                        {activeTab === 'offers' && (
                            <div className="animate-fade-in">
                                <OfferPanel
                                    listingId={Number(id)}
                                    listingToken={listing?.token ?? ""}
                                    isOwner={isOwn}
                                    offers={offers}
                                    isLoadingOffers={isLoadingOffers}
                                    onRefreshOffers={refreshOffers}
                                    onMakeOffer={handleMakeOffer}
                                    isMakingOffer={isOffering}
                                    makeOfferError={offerError}
                                    isActive={isActive}
                                    ownerPublicKey={publicKey}
                                />
                            </div>
                        )}
                    </div>
                </div>

                {/* RIGHT COLUMN: Action Panel */}
                <div className="space-y-8 animate-fade-in-right sticky top-28">
                    <div className="p-6 md:p-10 rounded-[3rem] bg-gradient-to-br from-white/10 to-white/5 border border-white/10 backdrop-blur-md shadow-2xl relative overflow-hidden">
                        {/* Background glows */}
                        <div className="absolute -top-10 -right-10 w-40 h-40 bg-brand-500/10 blur-3xl rounded-full" />
                        <div className="absolute -bottom-10 -left-10 w-40 h-40 bg-terracotta-500/10 blur-3xl rounded-full" />

                        <div className="relative">
                            <h1 className="text-4xl md:text-5xl font-display font-bold text-white mb-2 leading-tight">
                                {metadata?.title || `Art Asset #${id}`}
                            </h1>

                            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-4 mb-8">
                                <div className="flex -space-x-3">
                                    <div className="w-8 h-8 rounded-full bg-brand-500 border-2 border-midnight-950 flex items-center justify-center text-white font-bold text-xs ring-2 ring-brand-500/20">A</div>
                                    <div className="w-8 h-8 rounded-full bg-terracotta-500 border-2 border-midnight-950 flex items-center justify-center text-white font-bold text-xs ring-2 ring-terracotta-500/20">B</div>
                                </div>
                                <p className="text-sm text-white/40 font-medium">
                                    Collection: <span className="text-white">Elcare-Hub Origins</span>
                                </p>
                            </div>

                            {/* Price / Auction Stats */}
                            <div className="grid grid-cols-1 gap-6 mb-10">
                                <div className="p-6 rounded-3xl bg-midnight-950/50 border border-white/5 shadow-inner">
                                    <div className="flex justify-between items-start mb-4">
                                        <div>
                                            <p className="text-[10px] uppercase tracking-[0.2em] text-white/30 font-black mb-1">
                                                {listing ? "Fixed Price" : "Current Bid"}
                                            </p>
                                            <div className="flex items-baseline gap-2">
                                                <span className="text-5xl font-display font-bold text-white">{priceDisplay}</span>
                                                <span className="text-brand-400 font-bold">XLM</span>
                                            </div>
                                            <p className="text-xs text-white/30 mt-1 font-mono">≈ {(Number(priceDisplay) * 0.12).toFixed(2)} USD</p>
                                        </div>

                                        {auction && (
                                            <div className="text-right">
                                                <p className="text-[10px] uppercase tracking-[0.2em] text-white/30 font-black mb-1">Ends In</p>
                                                <div className="flex items-center gap-2 text-terracotta-400 font-bold">
                                                    <Clock size={16} />
                                                    <span className="text-xl tabular-nums">
                                                        {auction.end_time > Math.floor(Date.now() / 1000)
                                                            ? new Date((Number(auction.end_time) - Math.floor(Date.now() / 1000)) * 1000).toISOString().substr(11, 8)
                                                            : "Ended"}
                                                    </span>
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    {listing && (
                                        <div className="flex items-center gap-2 py-2 px-3 bg-mint-500/10 rounded-xl border border-mint-500/20 w-fit">
                                            <ShieldCheck size={14} className="text-mint-400" />
                                            <span className="text-[10px] font-bold text-mint-400 uppercase tracking-widest">Escrow Verified</span>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Action Area */}
                            <div className="space-y-4">
                                {listing && isActive && !isOwn && (
                                    <GuardButton
                                        onAction={handleBuy}
                                        disabled={isBuying}
                                        actionName="To buy this artwork"
                                        className="w-full flex items-center justify-center gap-3 rounded-2xl bg-gradient-to-r from-brand-500 to-terracotta-500 py-5 text-lg font-black text-white shadow-xl shadow-brand-500/30 hover:shadow-brand-500/50 hover:scale-[1.02] transition-all active:scale-95 disabled:opacity-50"
                                    >
                                        <ShoppingCart size={24} />
                                        {isBuying ? "Processing Payment..." : "Purchase Artwork"}
                                    </GuardButton>
                                )}

                                {auction && isActive && !isOwn && (
                                    <div className="space-y-4">
                                        <div className="flex flex-col sm:flex-row gap-4">
                                            <input
                                                type="number"
                                                placeholder="Bid amount..."
                                                value={bidAmount}
                                                onChange={(e) => setBidAmount(e.target.value)}
                                                className="w-full sm:flex-1 rounded-2xl bg-white/5 border border-white/10 px-6 py-4 sm:py-0 text-white text-lg font-bold focus:outline-none focus:border-brand-500 transition-all"
                                            />
                                            <GuardButton
                                                onAction={handleBid}
                                                disabled={isBidding || !bidAmount}
                                                actionName="To place a bid"
                                                className="w-full sm:w-auto rounded-2xl bg-white text-midnight-950 px-8 py-5 text-lg font-black hover:bg-brand-400 hover:text-white transition-all active:scale-95 disabled:opacity-50"
                                            >
                                                <Gavel size={24} />
                                            </GuardButton>
                                        </div>
                                        <p className="text-[10px] text-center text-white/30 uppercase tracking-widest">Must be at least 5% higher than current bid</p>
                                    </div>
                                )}

                                {/* Offer Panel (below buy button, listing only) */}
                                {listing && isActive && (
                                    <OfferPanel
                                        listingId={Number(id)}
                                        listingToken={listing.token}
                                        isOwner={isOwn}
                                        offers={offers}
                                        isLoadingOffers={isLoadingOffers}
                                        onRefreshOffers={refreshOffers}
                                        onMakeOffer={handleMakeOffer}
                                        isMakingOffer={isOffering}
                                        makeOfferError={offerError}
                                        isActive={isActive}
                                        ownerPublicKey={publicKey}
                                    />
                                )}

                                {isOwn && (
                                    <div className="p-6 rounded-2xl bg-brand-500/20 border border-brand-500/30 text-center">
                                        <p className="text-brand-400 font-bold flex items-center justify-center gap-2">
                                            <CheckCircle2 size={18} />
                                            You own this listing
                                        </p>
                                    </div>
                                )}

                                {(status === "Sold" || status === "Finalized") && (
                                    <div className="p-6 rounded-2xl bg-white/5 border border-white/10 text-center">
                                        <p className="text-white/40 font-bold italic">
                                            This asset has been privately collected.
                                        </p>
                                    </div>
                                )}

                                {(buyError || bidError) && (
                                    <div className="p-4 rounded-xl bg-terracotta-500/10 border border-terracotta-500/20 text-terracotta-400 text-xs flex items-center gap-3">
                                        <AlertCircle size={16} />
                                        {buyError || bidError}
                                    </div>
                                )}

                                {/* Secondary Actions: Share + Provenance */}
                                <div className="flex gap-3 pt-6">
                                    {/* Social share buttons */}
                                    <SocialShare
                                        title={metadata?.title ?? `Listing #${id}`}
                                        price={`${priceDisplay} XLM`}
                                        url={listingUrl}
                                        className="flex-1"
                                    />
                                    <button
                                        onClick={handleProvenance}
                                        title="View on-chain provenance history"
                                        data-testid="provenance-btn"
                                        className="h-11 px-4 rounded-xl bg-white/5 hover:bg-white/10 transition-all border border-white/10 flex items-center gap-2 text-xs font-bold text-white/60"
                                    >
                                        <History size={14} />
                                        <span className="hidden sm:inline">Provenance</span>
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Royalty Disclosure */}
                    <div className="p-6 rounded-3xl border border-brand-500/10 bg-brand-500/5 backdrop-blur-sm">
                        <div className="flex items-center gap-3 mb-3">
                            <div className="w-10 h-10 rounded-full bg-brand-500/20 flex items-center justify-center text-brand-400">
                                <TrendingUp size={18} />
                            </div>
                            <div>
                                <h4 className="text-sm font-bold text-white">Creator Earnings</h4>
                                <p className="text-xs text-brand-400 font-medium">Verified Royalty Support</p>
                            </div>
                        </div>
                        <p className="text-xs text-white/50 leading-relaxed mb-4">
                            This artwork supports creators with a <span className="text-white font-bold">{royaltyPercent}%</span> royalty on all future secondary sales. Elcare-Hub&apos;s smart contract automatically enforces these splits to ensure fair compensation.
                        </p>
                        <div className="flex justify-between text-[10px] font-bold text-white/30 uppercase tracking-widest border-t border-white/5 pt-4">
                            <span>Contract ID</span>
                            <span className="font-mono">{id}</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
