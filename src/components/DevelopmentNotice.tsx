import { UI_STRINGS } from "@/lib/constants";

export default function DevelopmentNotice() {
    return (
        <div className="bg-amber-500 py-2">
            <div className="container mx-auto px-4 text-center">
                <p className="text-sm font-bold text-black">
                    {UI_STRINGS.DEVELOPMENT_NOTICE.TEXT}
                </p>
            </div>
        </div>
    );
}
