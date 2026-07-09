import { useNavigate } from "react-router-dom";
import { Card } from "@/components/ui/card";
import LoginForm from "../components/LoginForm";

export default function LoginPage() {
  const navigate = useNavigate();

  return (
    <div className="flex min-h-[calc(100vh-61px)] items-center justify-center px-6 py-8">
      <Card className="w-full max-w-sm p-6">
        <LoginForm onSuccess={() => navigate("/dashboard")} />
      </Card>
    </div>
  );
}
