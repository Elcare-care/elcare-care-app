import { NextResponse } from "next/server";
import { validateIpfsCid } from "@/lib/validation";

const PINATA_BASE = "https://api.pinata.cloud";

interface ArtworkMetadata {
  title: string;
  description: string;
  artist: string;
  image: string;
  year: string;
  category: string;
}

function getPinataJwt(): string {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    throw new Error("Missing server env var: PINATA_JWT");
  }
  return jwt;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      metadata?: ArtworkMetadata;
      name?: string;
    };

    if (!body.metadata) {
      return NextResponse.json(
        { error: "Missing metadata payload." },
        { status: 400 }
      );
    }

    const pinataBody = {
      pinataContent: body.metadata,
      pinataMetadata: {
        name: body.name ?? `${body.metadata.title}-metadata.json`,
      },
      pinataOptions: { cidVersion: 1 },
    };

    const pinataRes = await fetch(`${PINATA_BASE}/pinning/pinJSONToIPFS`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getPinataJwt()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(pinataBody),
    });

    if (!pinataRes.ok) {
      const resBody = await pinataRes.text();
      return NextResponse.json(
        { error: `Pinata metadata upload failed: ${resBody}` },
        { status: 502 }
      );
    }

    const data = (await pinataRes.json()) as { IpfsHash: string };
    const cid = data.IpfsHash;

    // Validate the CID returned by Pinata before surfacing it to the client.
    // A malformed CID would silently cause a contract InvalidCid error when
    // the artist tries to create a listing, and break indexer metadata fetches.
    const cidError = validateIpfsCid(cid);
    if (cidError) {
      console.error("[upload-metadata] Pinata returned a malformed CID", { cid, cidError });
      return NextResponse.json(
        { error: `Pinata returned a malformed CID: ${cidError}` },
        { status: 502 }
      );
    }

    return NextResponse.json({ cid });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
