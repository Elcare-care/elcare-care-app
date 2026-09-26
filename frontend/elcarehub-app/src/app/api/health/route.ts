import { NextResponse } from 'next/server';

/**
 * Health check endpoint for container orchestration and monitoring.
 * Returns a simple JSON response indicating the service is healthy.
 * 
 * This endpoint is used by Docker health checks and Kubernetes liveness probes.
 */
export async function GET() {
  return NextResponse.json(
    {
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'elcarehub-frontend',
      version: process.env.APP_VERSION || '0.1.0',
    },
    { status: 200 }
  );
}