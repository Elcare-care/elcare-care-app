import { NextResponse } from "next/server";

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
    return NextResponse.json({ cid: data.IpfsHash });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
