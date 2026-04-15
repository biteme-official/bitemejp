import { initiateLineLogin } from '@/lib/line-auth';

interface LineLoginButtonProps {
  className?: string;
}

export function LineLoginButton({ className }: LineLoginButtonProps) {
  return (
    <button
      onClick={initiateLineLogin}
      className={`flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-md text-white font-medium text-sm transition-colors hover:opacity-90 ${className ?? ''}`}
      style={{ backgroundColor: '#06C755' }}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path
          d="M12 2C6.48 2 2 5.82 2 10.5c0 4.21 3.74 7.74 8.79 8.4.34.07.81.22.93.51.1.26.07.67.03.93l-.15.91c-.05.27-.22 1.07.94.58 1.16-.49 6.26-3.69 8.54-6.32C22.84 13.54 22 12.13 22 10.5 22 5.82 17.52 2 12 2Z"
          fill="white"
        />
      </svg>
      LINEでログイン
    </button>
  );
}
