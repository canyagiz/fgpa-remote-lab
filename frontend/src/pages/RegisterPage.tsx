import { Card } from "@/components/ui/card";
import RegisterForm from "../components/RegisterForm";

export default function RegisterPage() {
  return (
    <div className="flex min-h-[calc(100vh-61px)] items-center justify-center px-6 py-8">
      <Card className="w-full max-w-sm p-6">
        <RegisterForm />
      </Card>
    </div>
  );
}
