import { NextResponse } from "next/server";

const PINATA_BASE = "https://api.pinata.cloud";

function getPinataJwt(): string {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    throw new Error("Missing server env var: PINATA_JWT");
  }
  return jwt;
}

export async function POST(req: Request) {
  try {
    const incoming = await req.formData();
    const file = incoming.get("file");
    const name = String(incoming.get("name") ?? "artwork");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Missing file in form data." },
        { status: 400 }
      );
    }

    const formData = new FormData();
    formData.append("file", file);
    formData.append("pinataMetadata", JSON.stringify({ name }));
    formData.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));

    const pinataRes = await fetch(`${PINATA_BASE}/pinning/pinFileToIPFS`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getPinataJwt()}`,
      },
      body: formData,
    });

    if (!pinataRes.ok) {
      const body = await pinataRes.text();
      return NextResponse.json(
        { error: `Pinata upload failed: ${body}` },
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
