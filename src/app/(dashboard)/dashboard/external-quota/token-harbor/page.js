import TokenHarborQuotaCard from "./TokenHarborQuotaCard";

export const metadata = {
  title: "Token Harbor Free Quota",
  description: "Monitor your free tier usage on Token Harbor",
};

export default function TokenHarborPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text">Token Harbor</h1>
        <p className="text-sm text-text-muted/70 mt-1">
          Free tier quota monitoring
        </p>
      </div>

      <TokenHarborQuotaCard />
    </div>
  );
}
