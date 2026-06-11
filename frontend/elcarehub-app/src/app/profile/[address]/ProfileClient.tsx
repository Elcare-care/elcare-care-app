"use client";

import { useEffect, useState, useMemo } from "react";
import { useParams } from "next/navigation";
import { useWalletContext } from "@/context/WalletContext";
import { WalletGuard } from "@/components/WalletGuard";
import { EnrichedListing, useArtistListings, useMarketplace } from "@/hooks/useMarketplace";
import { useUserActivity } from "@/hooks/useUserActivity";
import { ListingCard } from "@/components/ListingCard";
import {
    History,
    Package,
    Tag,
    ShoppingBag,
    ShoppingCart,
    TrendingUp,
    Clock,
    ExternalLink,
    ChevronRight,
    User as UserIcon,
    Award,
    CircleDollarSign,
    Activity
} from "lucide-react";
import { Listing, stroopsToXlm } from "@/lib/contract";
import { ActivityEvent } from "@/lib/indexer";
import { clsx } from "clsx";

type ProfileTab = "purchased" | "listings" | "sold" | "activity";

interface ProfileClientProps {
  address: string;
}

export default function ProfileClient({ address }: ProfileClientProps) {
    const { publicKey } = useWalletContext();
    const [activeTab, setActiveTab] = useState<ProfileTab>("purchased");
    const isOwnProfile = publicKey === address;

    // Hook for Indexer activity - use the address from props or current user
    const {
        activities,
        royaltyStats,
        isLoading: loadingActivity
    } = useUserActivity(isOwnProfile ? publicKey : address);

    // Contract state
    const { listings: allListings, isLoading: loadingAll } = useMarketplace();
    const { listings: myArtistListings, isLoading: loadingArtist } = useArtistListings(isOwnProfile ? publicKey : address);

    const isGlobalLoading = loadingAll || loadingArtist || loadingActivity;

    // Derive "Purchased" - only for own profile
    const purchasedArtworks = useMemo(() => {
        if (!isOwnProfile || !publicKey) return [];
        return allListings.filter(l => l.owner === publicKey && l.artist !== publicKey);
    }, [allListings, publicKey, isOwnProfile]);

    const soldArtworks = useMemo(() => {
        return myArtistListings.filter(l => l.status === "Sold");
    }, [myArtistListings]);

    const activeListings = useMemo(() => {
        return myArtistListings.filter(l => l.status === "Active");
    }, [myArtistListings]);

    const displayAddress = isOwnProfile ? publicKey : address;

    return (
        <div className="min-h-screen bg-midnight-950 pb-20 pt-24 selection:bg-brand-500 selection:text-white">
            {/* Heritage Background Pattern */}
            <div className="fixed inset-0 pointer-events-none opacity-[0.03] z-0 overflow-hidden">
                <div className="absolute inset-0 tribal-pattern scale-150 rotate-12" />
            </div>

            {(isOwnProfile ? (
                <WalletGuard actionName="To access your personal art gallery">
                    <ProfileContent
                        displayAddress={displayAddress}
                        isOwnProfile={isOwnProfile}
                        activeTab={activeTab}
                        setActiveTab={setActiveTab}
                        purchasedArtworks={purchasedArtworks}
                        soldArtworks={soldArtworks}
                        activeListings={activeListings}
                        myArtistListings={myArtistListings}
                        royaltyStats={royaltyStats}
                        activities={activities}
                        isGlobalLoading={isGlobalLoading}
                    />
                </WalletGuard>
            ) : (
                <ProfileContent
                    displayAddress={displayAddress}
                    isOwnProfile={isOwnProfile}
                    activeTab={activeTab}
                    setActiveTab={setActiveTab}
                    purchasedArtworks={[]}
                    soldArtworks={soldArtworks}
                    activeListings={activeListings}
                    myArtistListings={myArtistListings}
                    royaltyStats={royaltyStats}
                    activities={activities}
                    isGlobalLoading={isGlobalLoading}
                />
            ))}
        </div>
    );
}

interface ProfileContentProps {
    displayAddress: string | null;
    isOwnProfile: boolean;
    activeTab: ProfileTab;
    setActiveTab: (tab: ProfileTab) => void;
    purchasedArtworks: Listing[];
    soldArtworks: Listing[];
    activeListings: Listing[];
    myArtistListings: Listing[];
    royaltyStats: any;
    activities: ActivityEvent[];
    isGlobalLoading: boolean;
}

function ProfileContent({
    displayAddress,
    isOwnProfile,
    activeTab,
    setActiveTab,
    purchasedArtworks,
    soldArtworks,
    activeListings,
    myArtistListings,
    royaltyStats,
    activities,
    isGlobalLoading
}: ProfileContentProps) {
    return (
        <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            {/* Profile Header — Heritage Glow Design */}
            <div className="relative mb-12 overflow-hidden rounded-[3rem] bg-midnight-900 border border-white/5 shadow-2xl p-8 sm:p-12">
                {/* Background Accents */}
                <div className="absolute -top-24 -right-24 h-64 w-64 rounded-full bg-brand-500/10 blur-[100px]" />
                <div className="absolute -bottom-24 -left-24 h-64 w-64 rounded-full bg-mint-500/10 blur-[100px]" />
                <div className="absolute top-0 right-0 left-0 tribal-strip h-1.5 opacity-40" />

                <div className="relative flex flex-col items-center justify-between gap-10 md:flex-row md:items-start">
                    {/* User Identity Section */}
                    <div className="flex flex-col items-center gap-8 md:flex-row md:items-start text-center md:text-left">
                        <div className="relative group">
                            <div className="absolute -inset-1.5 rounded-[2.5rem] bg-gradient-to-tr from-brand-500 via-terracotta-400 to-mint-500 opacity-80 blur transition duration-700 group-hover:opacity-100 group-hover:duration-200"></div>
                            <div className="relative flex h-28 w-28 items-center justify-center rounded-[2.2rem] bg-midnight-950 border border-white/10 shadow-2xl overflow-hidden group-hover:scale-[1.02] transition-transform duration-500">
                                <UserIcon size={56} className="text-brand-400/80 group-hover:text-brand-400 transition-colors" />
                                <div className="absolute bottom-0 right-0 h-8 w-8 bg-mint-500 text-midnight-950 flex items-center justify-center rounded-tl-2xl shadow-lg border-t border-l border-white/20">
                                    <Award size={16} />
                                </div>
                            </div>
                        </div>

                        <div className="flex flex-col gap-4">
                            <div className="space-y-1">
                                <h1 className="font-display text-4xl sm:text-5xl font-bold tracking-tight text-white">
                                    African <span className="text-brand-400">{isOwnProfile ? 'Patron' : 'Artist'}</span>
                                </h1>
                                <p className="text-brand-300/60 font-medium text-sm tracking-widest uppercase">
                                    {isOwnProfile ? 'Member Since 2025 • Collector Tier I' : 'Digital Artist • Stellar Creator'}
                                </p>
                            </div>

                            <div className="flex flex-col gap-3 font-mono">
                                <p className="text-[11px] sm:text-xs text-mint-400/90 break-all bg-white/5 px-4 py-2.5 rounded-2xl border border-white/10 backdrop-blur-md shadow-inner">
                                    {displayAddress}
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* Stats Dashboard */}
                    <div className="grid grid-cols-2 gap-6 md:gap-8">
                        <div className="text-center">
                            <div className="flex items-center justify-center gap-2 text-brand-400 font-bold text-2xl mb-1">
                                <Package size={20} />
                                {myArtistListings.length}
                            </div>
                            <p className="text-[10px] uppercase tracking-widest text-white/30 font-black">Created</p>
                        </div>
                        <div className="text-center">
                            <div className="flex items-center justify-center gap-2 text-mint-400 font-bold text-2xl mb-1">
                                <CircleDollarSign size={20} />
                                {royaltyStats?.totalEarned ? parseFloat(royaltyStats.totalEarned).toFixed(2) : '0'} XLM
                            </div>
                            <p className="text-[10px] uppercase tracking-widest text-white/30 font-black">Total Volume</p>
                        </div>
                    </div>
                </div>
            </div>

            {/* Tab Navigation */}
            <div className="mb-8">
                <div className="flex gap-2 p-1 bg-white/5 rounded-2xl backdrop-blur-sm border border-white/10">
                    {isOwnProfile && (
                        <button
                            onClick={() => setActiveTab("purchased")}
                            className={`flex-1 flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-bold text-sm uppercase tracking-wider transition-all ${activeTab === "purchased" 
                                ? "bg-brand-500 text-white shadow-lg shadow-brand-500/20" 
                                : "text-white/40 hover:text-white hover:bg-white/5"
                            }`}
                        >
                            <ShoppingBag size={16} />
                            Purchased
                        </button>
                    )}
                    <button
                        onClick={() => setActiveTab("listings")}
                        className={`flex-1 flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-bold text-sm uppercase tracking-wider transition-all ${activeTab === "listings" 
                            ? "bg-brand-500 text-white shadow-lg shadow-brand-500/20" 
                            : "text-white/40 hover:text-white hover:bg-white/5"
                        }`}
                    >
                        <Tag size={16} />
                        Listings
                    </button>
                    <button
                        onClick={() => setActiveTab("sold")}
                        className={`flex-1 flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-bold text-sm uppercase tracking-wider transition-all ${activeTab === "sold" 
                            ? "bg-brand-500 text-white shadow-lg shadow-brand-500/20" 
                            : "text-white/40 hover:text-white hover:bg-white/5"
                        }`}
                    >
                        <TrendingUp size={16} />
                        Sold
                    </button>
                    <button
                        onClick={() => setActiveTab("activity")}
                        className={`flex-1 flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-bold text-sm uppercase tracking-wider transition-all ${activeTab === "activity" 
                            ? "bg-brand-500 text-white shadow-lg shadow-brand-500/20" 
                            : "text-white/40 hover:text-white hover:bg-white/5"
                        }`}
                    >
                        <Activity size={16} />
                        Activity
                    </button>
                </div>
            </div>

            {/* Tab Content */}
            <div className="min-h-[400px]">
                {isGlobalLoading ? (
                    <div className="flex flex-col items-center justify-center py-20">
                        <div className="h-12 w-12 animate-spin rounded-full border-4 border-brand-200 border-t-brand-500 mb-4" />
                        <p className="text-brand-300 font-display italic">Loading gallery...</p>
                    </div>
                ) : (
                    <>
                        {isOwnProfile && activeTab === "purchased" && (
                            <div>
                                {purchasedArtworks.length > 0 ? (
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                                        {purchasedArtworks.map((listing) => (
                                            <ListingCard key={listing.listing_id} listing={listing} />
                                        ))}
                                    </div>
                                ) : (
                                    <div className="text-center py-20">
                                        <ShoppingBag size={48} className="mx-auto mb-4 text-white/20" />
                                        <p className="text-white/40 font-display text-lg">No purchased artworks yet</p>
                                        <p className="text-white/20 text-sm mt-2">Start building your collection from African artists</p>
                                    </div>
                                )}
                            </div>
                        )}

                        {activeTab === "listings" && (
                            <div>
                                {activeListings.length > 0 ? (
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                                        {activeListings.map((listing) => (
                                            <ListingCard key={listing.listing_id} listing={listing} />
                                        ))}
                                    </div>
                                ) : (
                                    <div className="text-center py-20">
                                        <Tag size={48} className="mx-auto mb-4 text-white/20" />
                                        <p className="text-white/40 font-display text-lg">No active listings</p>
                                        <p className="text-white/20 text-sm mt-2">{isOwnProfile ? 'Create your first listing' : 'This artist has no active listings'}</p>
                                    </div>
                                )}
                            </div>
                        )}

                        {activeTab === "sold" && (
                            <div>
                                {soldArtworks.length > 0 ? (
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                                        {soldArtworks.map((listing) => (
                                            <ListingCard key={listing.listing_id} listing={listing} />
                                        ))}
                                    </div>
                                ) : (
                                    <div className="text-center py-20">
                                        <TrendingUp size={48} className="mx-auto mb-4 text-white/20" />
                                        <p className="text-white/40 font-display text-lg">No sold artworks</p>
                                        <p className="text-white/20 text-sm mt-2">Sales history will appear here</p>
                                    </div>
                                )}
                            </div>
                        )}

                        {activeTab === "activity" && (
                            <div>
                                {activities.length > 0 ? (
                                    <div className="space-y-4">
                                        {activities.map((activity, idx) => (
                                            <div key={idx} className="p-4 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-between">
                                                <div className="flex items-center gap-4">
                                                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                                                        activity.type === 'LISTED' ? 'bg-white/10 text-white' :
                                                        activity.type === 'PURCHASE' || activity.type === 'SALE' ? 'bg-mint-500/20 text-mint-400' :
                                                        'bg-brand-500/20 text-brand-400'
                                                    }`}>
                                                        {activity.type === 'LISTED' && <Tag size={18} />}
                                                        {(activity.type === 'PURCHASE' || activity.type === 'SALE') && <ShoppingCart size={18} />}
                                                        {activity.type === 'ROYALTY' && <TrendingUp size={18} />}
                                                    </div>
                                                    <div>
                                                        <p className="text-white font-bold">{activity.type}</p>
                                                        <p className="text-white/40 text-sm">{new Date(activity.timestamp).toLocaleDateString()}</p>
                                                    </div>
                                                </div>
                                                {activity.price && (
                                                    <div className="text-right">
                                                        <p className="text-brand-400 font-bold">{activity.price} XLM</p>
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="text-center py-20">
                                        <Activity size={48} className="mx-auto mb-4 text-white/20" />
                                        <p className="text-white/40 font-display text-lg">No activity yet</p>
                                        <p className="text-white/20 text-sm mt-2">Transaction history will appear here</p>
                                    </div>
                                )}
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
