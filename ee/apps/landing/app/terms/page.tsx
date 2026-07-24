import { LegalPage } from "../../components/legal-page";

export const metadata = {
  title: "JuggleWork — Terms of Use",
  description: "Terms of use for Different AI, doing business as JuggleWork.",
  alternates: {
    canonical: "/terms"
  }
};

export default function TermsPage() {
  return <LegalPage file="terms/terms-of-use.md" />;
}
