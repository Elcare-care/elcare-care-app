"use client";

import { Navbar } from "@/components/Navbar";
import { CollectionForm } from "@/components/CollectionForm";

export default function CreateCollectionPage() {
  return (
    <main className="min-h-screen bg-brand-50/20">
      <Navbar />
      
      <div className="pt-24 pb-12">
        <div className="max-w-7xl mx-auto px-4">
          <div className="flex flex-col items-center mb-8">
            <span className="inline-block px-4 py-1.5 rounded-full bg-brand-100 text-brand-600 text-sm font-bold uppercase tracking-widest mb-4">
              Creator Studio
            </span>
            <h1 className="text-5xl font-display font-black text-gray-900 text-center">
              New Collection
            </h1>
          </div>
          
          <CollectionForm />
        </div>
      </div>
    </main>
  );
}
