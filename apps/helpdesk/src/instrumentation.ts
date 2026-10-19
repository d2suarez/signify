export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Railway containers have no public IPv6 route — always dial IPv4 first.
    const dns = await import("node:dns");
    dns.setDefaultResultOrder("ipv4first");
    const { startEmailIngestion } = await import("./lib/email-ingest");
    startEmailIngestion();
    const { startJobs } = await import("./lib/jobs");
    startJobs();
  }
}
