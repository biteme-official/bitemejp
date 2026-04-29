import { useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';

export default function DiscountRedirect() {
  const { code } = useParams<{ code: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  useEffect(() => {
    if (code) {
      localStorage.setItem('affiliate_discount', code.toUpperCase());
    }
    const redirect = searchParams.get('redirect') || '/';
    navigate(redirect, { replace: true });
  }, []);

  return null;
}
