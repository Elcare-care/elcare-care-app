"use client";

import { useEffect, useState, useMemo } from "react";
import { useWalletContext } from "@/context/WalletContext";
import { WalletGuard } from "@/components/WalletGuard";
import { useArtistListings, useMarketplace } from "@/hooks/useMarketplace";
import { useUserActivity } from "@/hooks/useUserActivity";
import { useCreatorCollections } from "@/hooks/useLaunchpad";
import { ListingCard } from "@/components/ListingCard";
import Link from "next/link";
import {
    History,
    Package,
    Tag,
    ShoppingBag,
    ShoppingCart,
    TrendingUp,
    ExternalLink,
    User as UserIcon,
    Award,
    CircleDollarSign,
    Activity,
    Layers,
    Coins,
} from "lucide-react";
import { Listing } from "@/lib/contract";
import { ActivityEvent } from "@/lib/indexer";

type ProfileTab = "purchased" | "listings" | "sold" | "collections" | "earnings" | "activity";

interface ProfileClientProps {
  address: string;
}

export default function ProfileClient({ address }: ProfileClientProps) {
    const { publicKey } = useWalletContext();
    const [activeTab, setActiveTab] = useState<ProfileTab>("listings");
    const isOwnProfile = publicKey === address;

    const {
        activities,
        royaltyStats,
        isLoading: loadingActivity,
    } = useUserActivity(isOwnProfile ? publicKey : address);

    const { listings: allListings, isLoading: loadingAll } = useMarketplace();
    const { listings: myArtistListings, isLoading: loadingArtist } = useArtistListings(
        isOwnProfile ? publicKey : address
    );
    const { collections, isLoading: loadingCollections } = useCreatorCollections(
        isOwnProfile ? publicKey : address
    );

    const isGlobalLoading = loadingAll || loadingArtist || loadingActivity || loadingCollections;

    const purchasedArtworks = useMemo(() => {
        if (!isOwnProfile || !publicKey) return [];
        return allListings.filter((l) => l.owner === publicKey && l.artist !== publicKey);
    }, [allListings, publicKey, isOwnProfile]);

    const soldArtworks = useMemo(
        () => myArtistListings.filter((l) => l.status === "Sold"),
        [myArtistListings]
    );

    const activeListings = useMemo(
        () => myArtistListings.filter((l) => l.status === "Active"),
        [myArtistListings]
    );

    const displayAddress = isOwnProfile ? publicKey : address;

    return (
        <div className="min-h-screen bg-midnight-950 pb-20 pt-24 selection:bg-brand-500 selection:text-white">
            <div className="fixed inset-0 pointer-events-none opacity-[0.03] z-0 overflow-hidden">
                <div className="absolute inset-0 tribal-pattern scale-150 rotate-12" />
            </div>

            {isOwnProfile ? (
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
                        collections={collections}
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
                    collections={collections}
                    royaltyStats={royaltyStats}
                    activities={activities}
                    isGlobalLoading={isGlobalLoading}
                />
            )}
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
    collections: any[];
    royaltyStats: any;
    activities: ActivityEvent[];
    isGlobalLoading: boolean;
}

const TABS: { id: ProfileTab; label: string; icon: React.ReactNode; ownOnly?: boolean }[] = [
    { id: "purchased", label: "Purchased", icon: <ShoppingBag size={16} />, ownOnly: true },
    { id: "listings", label: "Listings", icon: <Tag size={16} /> },
    { id: "sold", label: "Sold", icon: <TrendingUp size={16} /> },
    { id: "collections", label: "Collections", icon: <Layers size={16} /> },
    { id: "earnings", label: "Earnings", icon: <Coins size={16} /> },
    { id: "activity", label: "Activity", icon: <Activity size={16} /> },
];

function EmptyState({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle: string }) {
    return (
        <div className="text-center py-20">
            <div className="mx-auto mb-4 text-white/20 flex justify-center">{icon}</div>
            <p className="text-white/40 font-display text-lg">{title}</p>
            <p className="text-white/20 text-sm mt-2">{subtitle}</p>
        </div>
    );
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
    collections,
    royaltyStats,
    activities,
    isGlobalLoading,
}: ProfileContentProps) {
    const visibleTabs = TABS.filter((t) => !t.ownOnly || isOwnProfile);

    return (
        <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            {/* Profile Header */}
            <div className="relative mb-12 overflow-hidden rounded-[3rem] bg-midnight-900 border border-white/5 shadow-2xl p-8 sm:p-12">
                <div className="absolute -top-24 -right-24 h-64 w-64 rounded-full bg-brand-500/10 blur-[100px]" />
                <div className="absolute -bottom-24 -left-24 h-64 w-64 rounded-full bg-mint-500/10 blur-[100px]" />
                <div className="absolute top-0 right-0 left-0 tribal-strip h-1.5 opacity-40" />

                <div className="relative flex flex-col items-center justify-between gap-10 md:flex-row md:items-start">
                    <div className="flex flex-col items-center gap-8 md:flex-row md:items-start text-center md:text-left">
                        <div className="relative group">
                            <div className="absolute -inset-1.5 rounded-[2.5rem] bg-gradient-to-tr from-brand-500 via-terracotta-400 to-mint-500 opacity-80 blur transition duration-700 group-hover:opacity-100" />
                            <div className="relative flex h-28 w-28 items-center justify-center rounded-[2.2rem] bg-midnight-950 border border-white/10 shadow-2xl overflow-hidden">
                                <UserIcon size={56} className="text-brand-400/80" />
                                <div className="absolute bottom-0 right-0 h-8 w-8 bg-mint-500 text-midnight-950 flex items-center justify-center rounded-tl-2xl shadow-lg">
                                    <Award size={16} />
                                </div>
                            </div>
                        </div>

                        <div className="flex flex-col gap-4">
                            <div className="space-y-1">
                                <h1 className="font-display text-4xl sm:text-5xl font-bold tracking-tight text-white">
                                    African <span className="text-brand-400">{isOwnProfile ? "Patron" : "Artist"}</span>
                                </h1>
                                <p className="text-brand-300/60 font-medium text-sm tracking-widest uppercase">
                                    {isOwnProfile ? "Member Since 2025 • Collector Tier I" : "Digital Artist • Stellar Creator"}
                                </p>
                            </div>
                            <p className="text-[11px] sm:text-xs text-mint-400/90 break-all bg-white/5 px-4 py-2.5 rounded-2xl border border-white/10 backdrop-blur-md font-mono">
                                {displayAddress}
                            </p>
                        </div>
                    </div>

                    {/* Stats */}
                    <div className="grid grid-cols-3 gap-6">
                        <div className="text-center">
                            <div className="flex items-center justify-center gap-2 text-brand-400 font-bold text-2xl mb-1">
                                <Package size={20} />
                                {myArtistListings.length}
                            </div>
                            <p className="text-[10px] uppercase tracking-widest text-white/30 font-black">Created</p>
                        </div>
                        <div className="text-center">
                            <div className="flex items-center justify-center gap-2 text-mint-400 font-bold text-2xl mb-1">
                                <Layers size={20} />
                                {collections.length}
                            </div>
                            <p className="text-[10px] uppercase tracking-widest text-white/30 font-black">Collections</p>
                        </div>
                        <div className="text-center">
                            <div className="flex items-center justify-center gap-2 text-terracotta-400 font-bold text-2xl mb-1">
                                <CircleDollarSign size={20} />
                                {royaltyStats?.totalEarned ? parseFloat(royaltyStats.totalEarned).toFixed(2) : "0"} XLM
                            </div>
                            <p className="text-[10px] uppercase tracking-widest text-white/30 font-black">Royalties</p>
                        </div>
                    </div>
                </div>
            </div>

            {/* Tab Navigation */}
            <div className="mb-8">
                <div className="flex flex-wrap gap-2 p-1 bg-white/5 rounded-2xl backdrop-blur-sm border border-white/10">
                    {visibleTabs.map((tab) => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-bold text-sm uppercase tracking-wider transition-all ${
                                activeTab === tab.id
                                    ? "bg-brand-500 text-white shadow-lg shadow-brand-500/20"
                                    : "text-white/40 hover:text-white hover:bg-white/5"
                            }`}
                        >
                            {tab.icon}
                            {tab.label}
                        </button>
                    ))}
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
                            purchasedArtworks.length > 0 ? (
                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                                    {purchasedArtworks.map((l) => <ListingCard key={l.listing_id} listing={l} />)}
                                </div>
                            ) : (
                                <EmptyState icon={<ShoppingBag size={48} />} title="No purchased artworks yet" subtitle="Start building your collection from African artists" />
                            )
                        )}

                        {activeTab === "listings" && (
                            activeListings.length > 0 ? (
                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                                    {activeListings.map((l) => <ListingCard key={l.listing_id} listing={l} />)}
                                </div>
                            ) : (
                                <EmptyState icon={<Tag size={48} />} title="No active listings" subtitle={isOwnProfile ? "Create your first listing" : "This artist has no active listings"} />
                            )
                        )}

                        {activeTab === "sold" && (
                            soldArtworks.length > 0 ? (
                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                                    {soldArtworks.map((l) => <ListingCard key={l.listing_id} listing={l} />)}
                                </div>
                            ) : (
                                <EmptyState icon={<TrendingUp size={48} />} title="No sold artworks" subtitle="Sales history will appear here" />
                            )
                        )}

                        {activeTab === "collections" && (
                            collections.length > 0 ? (
                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                                    {collections.map((c) => (
                                        <div key={c.address} className="bg-midnight-900 rounded-3xl border border-white/5 p-6 hover:border-brand-500/30 transition-all">
                                            <div className="flex justify-between items-start mb-4">
                                                <span className="px-3 py-1 rounded-full text-xs font-bold tracking-wider uppercase bg-brand-500/20 text-brand-400">
                                                    {c.kind}
                                                </span>
                                                <Link href={`/launchpad/collections/${c.address}`} className="text-white/30 hover:text-brand-400 transition-colors">
                                                    <ExternalLink size={18} />
                                                </Link>
                                            </div>
                                            <p className="font-mono text-xs text-white/40 truncate mb-2">{c.address}</p>
                                            <Link
                                                href={`/launchpad/collections/${c.address}`}
                                                className="block text-center mt-4 py-2 rounded-xl bg-white/5 text-white/60 font-bold text-sm hover:bg-brand-500 hover:text-white transition-all"
                                            >
                                                View Collection
                                            </Link>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <EmptyState icon={<Layers size={48} />} title="No collections" subtitle={isOwnProfile ? "Deploy your first NFT collection on the Launchpad" : "This artist has no deployed collections"} />
                            )
                        )}

                        {activeTab === "earnings" && (
                            <div className="space-y-6">
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                                    <div className="bg-midnight-900 rounded-3xl border border-white/5 p-6">
                                        <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Total Royalties Earned</p>
                                        <p className="text-2xl font-bold text-terracotta-400">
                                            {royaltyStats?.totalEarned ? parseFloat(royaltyStats.totalEarned).toFixed(4) : "0"} XLM
                                        </p>
                                    </div>
                                    <div className="bg-midnight-900 rounded-3xl border border-white/5 p-6">
                                        <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Payout Count</p>
                                        <p className="text-2xl font-bold text-brand-400">{royaltyStats?.payoutCount ?? 0}</p>
                                    </div>
                                    <div className="bg-midnight-900 rounded-3xl border border-white/5 p-6">
                                        <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Last Payout</p>
                                        <p className="text-2xl font-bold text-mint-400">
                                            {royaltyStats?.lastPayout ? new Date(royaltyStats.lastPayout).toLocaleDateString() : "—"}
                                        </p>
                                    </div>
                                </div>
                                {!royaltyStats?.payoutCount && (
                                    <EmptyState icon={<Coins size={48} />} title="No royalty payouts yet" subtitle="Royalties are paid automatically on secondary sales" />
                                )}
                            </div>
                        )}

                        {activeTab === "activity" && (
                            activities.length > 0 ? (
                                <div className="space-y-4">
                                    {activities.map((activity, idx) => (
                                        <div key={idx} className="p-4 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-between">
                                            <div className="flex items-center gap-4">
                                                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                                                    activity.type === "LISTED" ? "bg-white/10 text-white" :
                                                    activity.type === "PURCHASE" || activity.type === "SALE" ? "bg-mint-500/20 text-mint-400" :
                                                    "bg-brand-500/20 text-brand-400"
                                                }`}>
                                                    {activity.type === "LISTED" && <Tag size={18} />}
                                                    {(activity.type === "PURCHASE" || activity.type === "SALE") && <ShoppingCart size={18} />}
                                                    {activity.type === "ROYALTY" && <TrendingUp size={18} />}
                                                </div>
                                                <div>
                                                    <p className="text-white font-bold">{activity.type}</p>
                                                    <p className="text-white/40 text-sm">{new Date(activity.timestamp).toLocaleDateString()}</p>
                                                </div>
                                            </div>
                                            {activity.price && (
                                                <p className="text-brand-400 font-bold">{activity.price} XLM</p>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <EmptyState icon={<Activity size={48} />} title="No activity yet" subtitle="Transaction history will appear here" />
                            )
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
