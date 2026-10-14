import { PageHeader } from "@/components/ui/misc";
import { CredentialsTab } from "./Connections";

export default function CredentialsPage() {
  return (
    <>
      <PageHeader
        title="Credentials"
        description="Reusable sign-in details that several connection methods can share. Secrets are encrypted and never shown again after saving."
      />
      <CredentialsTab />
    </>
  );
}
