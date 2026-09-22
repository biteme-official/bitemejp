import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Copy, ImagePlus, Plus, Search, Sparkles, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BannerSlide } from "@/components/home/BannerSlide";
import {
  DEFAULT_SETTINGS,
  HomeBanner,
  HomeBannersDoc,
  MobileRatio,
  ProductForBanner,
  emptyBanner,
  fetchHomeBanners,
  fetchProductForBanner,
  importFromShopify,
  isHomeBannerLive,
  newBannerId,
  photoCroppable,
  photoUrl,
} from "@/lib/homeBanners";
import { cn } from "@/lib/utils";

/**
 * 어드민 「메인 배너」 탭 (#194) — Shopify 를 거치지 않고 여기서 배너를 만들고 배치한다.
 *
 * 왼쪽 목록에서 고르고 오른쪽에서 고친다. 미리보기(PC·모바일)는 실제 메인이 쓰는 BannerSlide 그대로라
 * 여기서 본 모습이 그대로 나간다. 문구 자리는 고정(위에서부터 배지→부제→헤드라인, CTA 는 아래 기준선).
 *
 * 처음 열었을 때 자체 문서가 없으면 Shopify 메타오브젝트 배너를 그대로 가져와 채운다(이미지 주소는
 * Shopify CDN 그대로). 「저장」을 누르는 순간부터 메인은 이 문서만 읽는다.
 *
 * 저장은 문서 전체를 한 번에 — 저장 전엔 서버에 아무것도 안 바뀐다. 이미지 업로드만 즉시 올라간다.
 *
 * 「상품 링크로」: 디자이너 배너 없이 상품 링크만 주면 그 상품 이미지들을 보여주고, 고른 한 장을 오른쪽에 놓는다.
 * 상품 썸네일은 위 25~30% 에 제목이 박혀 있어 「위 자르기」(기본 28%)로 잘라낸다 — 미리보기 보며 조절.
 */
const API = "/api/home-banners";

const RATIO_LABEL: Record<MobileRatio, string> = {
  "4:3": "4:3 (세로 있는 틀)",
  "1:1": "1:1 (정사각)",
  strip: "가로형 그대로 (PC 이미지)",
};

/** ISO ↔ datetime-local(JST) */
function isoToJstLocal(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t + 9 * 3600_000).toISOString().slice(0, 16);
}
function jstLocalToIso(local: string): string | null {
  if (!local) return null;
  const t = Date.parse(`${local}:00+09:00`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function statusOf(b: HomeBanner, now: number): { label: string; className: string } {
  if (!b.enabled) return { label: "꺼짐", className: "bg-neutral-100 text-neutral-500" };
  if (!b.pcImage && !b.photo) return { label: "이미지 없음", className: "bg-red-50 text-red-600" };
  if (b.startAt && now < Date.parse(b.startAt)) return { label: "예약", className: "bg-sky-50 text-sky-700" };
  if (b.endAt && now > Date.parse(b.endAt)) return { label: "종료", className: "bg-neutral-100 text-neutral-500" };
  return { label: "노출중", className: "bg-emerald-50 text-emerald-700" };
}

/**
 * 이미지 왼쪽 위 모서리 색 — 모바일에서 PC 이미지 바깥을 채울 배경색 후보.
 * 업로드 파일은 data: URL 로 읽는다(blob: 은 사이트 CSP img-src 에 막힘). 원격 주소(Shopify CDN·우리 버킷)는
 * CORS 를 열어 두고 있어 crossOrigin 으로 읽으면 캔버스가 안 더러워진다. 못 읽으면 null.
 */
function sampleCorner(src: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    if (!src.startsWith("data:")) img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = 4;
        c.height = 4;
        const ctx = c.getContext("2d");
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, 12, 12, 0, 0, 4, 4);
        const [r, g, b] = ctx.getImageData(1, 1, 1, 1).data;
        resolve(`#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function uploadImage(secret: string, file: File, dataUrl: string): Promise<string> {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ action: "upload", name: file.name, type: file.type, data: dataUrl }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `업로드 실패 (${res.status})`);
  return json.url as string;
}

export default function HomeBannersTab({ secret }: { secret: string }) {
  const [doc, setDoc] = useState<HomeBannersDoc | null>(null);
  const [savedJson, setSavedJson] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [importedFromShopify, setImportedFromShopify] = useState(false);
  const [uploading, setUploading] = useState<"pc" | "mobile" | null>(null);
  const pcFileRef = useRef<HTMLInputElement>(null);
  const mobileFileRef = useRef<HTMLInputElement>(null);
  const [productInput, setProductInput] = useState("");
  const [product, setProduct] = useState<ProductForBanner | null>(null);
  const [productLoading, setProductLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const src = await fetchHomeBanners();
        if (cancelled) return;
        if (src.source === "doc") {
          const d = { ...src.doc, settings: { ...DEFAULT_SETTINGS, ...src.doc.settings } };
          setDoc(d);
          setSavedJson(JSON.stringify(d));
          setSelectedId(d.banners[0]?.id ?? null);
        } else {
          const imported = await importFromShopify();
          // 배경색은 이미지 모서리에서 — 세로 틀로 바꿨을 때 바로 어울리게
          const banners = await Promise.all(
            imported.map(async (b) => ({ ...b, bg: (b.pcImage && (await sampleCorner(b.pcImage))) || b.bg })),
          );
          if (cancelled) return;
          const d: HomeBannersDoc = { version: 1, updatedAt: "", settings: { mobileRatio: "strip" }, banners };
          setDoc(d);
          setSavedJson(""); // 아직 저장된 적 없음 → 저장 버튼 활성
          setSelectedId(banners[0]?.id ?? null);
          setImportedFromShopify(true);
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "불러오기 실패");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setProduct(null);
    setProductInput("");
  }, [selectedId]);

  const dirty = doc !== null && JSON.stringify(doc) !== savedJson;
  const selected = useMemo(() => doc?.banners.find((b) => b.id === selectedId) ?? null, [doc, selectedId]);
  const now = Date.now();

  const updateBanner = useCallback((id: string, patch: Partial<HomeBanner>) => {
    setDoc((d) => d && { ...d, banners: d.banners.map((b) => (b.id === id ? { ...b, ...patch } : b)) });
  }, []);
  const updateText = useCallback((id: string, patch: Partial<HomeBanner["text"]>) => {
    setDoc((d) => d && { ...d, banners: d.banners.map((b) => (b.id === id ? { ...b, text: { ...b.text, ...patch } } : b)) });
  }, []);

  const addBanner = () => {
    const b = emptyBanner();
    setDoc((d) => d && { ...d, banners: [...d.banners, b] });
    setSelectedId(b.id);
  };
  const duplicateBanner = (id: string) => {
    setDoc((d) => {
      if (!d) return d;
      const i = d.banners.findIndex((b) => b.id === id);
      if (i < 0) return d;
      const copy: HomeBanner = { ...d.banners[i], id: newBannerId(), name: `${d.banners[i].name} (복사)`, text: { ...d.banners[i].text } };
      const next = [...d.banners];
      next.splice(i + 1, 0, copy);
      setSelectedId(copy.id);
      return { ...d, banners: next };
    });
  };
  const removeBanner = (id: string) => {
    setDoc((d) => {
      if (!d) return d;
      const next = d.banners.filter((b) => b.id !== id);
      if (selectedId === id) setSelectedId(next[0]?.id ?? null);
      return { ...d, banners: next };
    });
  };
  const move = (id: string, dir: -1 | 1) => {
    setDoc((d) => {
      if (!d) return d;
      const i = d.banners.findIndex((b) => b.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= d.banners.length) return d;
      const next = [...d.banners];
      [next[i], next[j]] = [next[j], next[i]];
      return { ...d, banners: next };
    });
  };

  const onPickImage = async (kind: "pc" | "mobile", file: File | undefined) => {
    if (!file || !selected) return;
    if (file.size > 3 * 1024 * 1024) {
      toast.error("이미지는 3MB 까지");
      return;
    }
    setUploading(kind);
    try {
      const dataUrl = await fileToDataUrl(file);
      const [url, corner] = await Promise.all([uploadImage(secret, file, dataUrl), kind === "pc" ? sampleCorner(dataUrl) : Promise.resolve(null)]);
      updateBanner(selected.id, kind === "pc" ? { pcImage: url, ...(corner ? { bg: corner } : {}) } : { mobileImage: url });
      toast.success("이미지 올림 — 「저장」해야 반영");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "업로드 실패");
    } finally {
      setUploading(null);
      if (pcFileRef.current) pcFileRef.current.value = "";
      if (mobileFileRef.current) mobileFileRef.current.value = "";
    }
  };

  const loadProduct = async () => {
    if (!productInput.trim()) return;
    setProductLoading(true);
    try {
      const p = await fetchProductForBanner(productInput);
      if (!p) throw new Error("상품을 못 찾았습니다 — biteme.co.jp/product/숫자 링크나 숫자 ID");
      setProduct(p);
      if (p.images.length === 0) toast.error("이 상품엔 이미지가 없습니다");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "상품 조회 실패");
    } finally {
      setProductLoading(false);
    }
  };

  /** 상품 이미지 한 장 고르기 — 위 28% 잘라서 오른쪽에. 이름·링크는 비어 있을 때만 채운다 */
  const pickProductImage = async (img: ProductForBanner["images"][number]) => {
    if (!selected || !product) return;
    const photo = { url: img.url, width: img.width, height: img.height, cropTop: 0.28 };
    const bg = await sampleCorner(photoUrl(photo, 200));
    updateBanner(selected.id, {
      photo,
      ...(bg ? { bg } : {}),
      ...(selected.name ? {} : { name: product.title }),
      ...(selected.link ? {} : { link: product.url }),
    });
  };

  /** AI(Gemini) 로 사진 속 글자를 지운 사본을 만들어 그걸로 바꾼다. 자르기는 0 으로 — 글자가 없어졌으니 */
  const cleanPhoto = async () => {
    if (!selected?.photo) return;
    setCleaning(true);
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ action: "clean", url: selected.photo.url }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `실패 (${res.status})`);
      const photo = { url: json.url as string, width: json.width as number, height: json.height as number, cropTop: 0 };
      const bg = await sampleCorner(photoUrl(photo, 200));
      updateBanner(selected.id, { photo, ...(bg ? { bg } : {}) });
      toast.success("글자를 지운 사진으로 바꿨습니다 — 미리보기 확인 후 저장");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "글자 지우기 실패");
    } finally {
      setCleaning(false);
    }
  };

  const save = async () => {
    if (!doc) return;
    setSaving(true);
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ action: "save", doc }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `저장 실패 (${res.status})`);
      const saved = json.doc as HomeBannersDoc;
      setDoc(saved);
      setSavedJson(JSON.stringify(saved));
      setImportedFromShopify(false);
      toast.success("저장했습니다. 메인은 1분 안에 바뀝니다");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setSaving(false);
    }
  };

  if (loading || !doc) return <p className="text-xs text-muted-foreground py-8 text-center">불러오는 중…</p>;

  const liveCount = doc.banners.filter((b) => isHomeBannerLive(b, now)).length;

  return (
    <div className="space-y-4">
      {/* 상태 띠 + 저장 */}
      <div className="rounded-lg border px-4 py-2.5 text-xs flex flex-wrap items-center gap-x-4 gap-y-2 bg-muted/40">
        <span className="font-semibold">배너 {doc.banners.length}개 · 지금 노출 {liveCount}개</span>
        {importedFromShopify ? (
          <span className="text-amber-700">Shopify 배너를 가져온 상태 — 아직 저장 안 됨. 저장하면 이때부터 여기서만 관리합니다</span>
        ) : (
          <span className="text-muted-foreground">마지막 저장 {doc.updatedAt ? new Date(doc.updatedAt).toLocaleString("ko-KR", { timeZone: "Asia/Tokyo" }) : "—"} (JST)</span>
        )}
        <div className="ml-auto flex items-center gap-3">
          <Label className="text-xs text-muted-foreground">모바일 틀</Label>
          <Select value={doc.settings.mobileRatio} onValueChange={(v) => setDoc({ ...doc, settings: { ...doc.settings, mobileRatio: v as MobileRatio } })}>
            <SelectTrigger className="h-8 w-52 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(RATIO_LABEL) as MobileRatio[]).map((k) => (
                <SelectItem key={k} value={k} className="text-xs">{RATIO_LABEL[k]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" className="h-8" disabled={!dirty || saving} onClick={save}>
            <Upload className="h-3.5 w-3.5 mr-1" />{saving ? "저장 중…" : dirty ? "저장" : "저장됨"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
        {/* 목록 */}
        <div className="space-y-2">
          {doc.banners.map((b, i) => {
            const st = statusOf(b, now);
            return (
              <div
                key={b.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedId(b.id)}
                onKeyDown={(e) => { if (e.key === "Enter") setSelectedId(b.id); }}
                className={cn(
                  "rounded-lg border p-2 flex gap-2 items-center cursor-pointer text-xs",
                  b.id === selectedId ? "border-primary bg-primary/5" : "hover:bg-muted/40",
                )}
              >
                <div className="w-16 h-7 rounded bg-muted overflow-hidden flex-shrink-0" style={{ background: b.bg }}>
                  {b.photo ? <img src={photoUrl(b.photo, 200)} alt="" className="w-full h-full object-contain" /> : b.pcImage && <img src={b.pcImage} alt="" className="w-full h-full object-cover" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{b.name || b.text.headline || "(이름 없음)"}</p>
                  <span className={cn("inline-block mt-0.5 px-1.5 py-px rounded text-[10px]", st.className)}>{st.label}</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <button type="button" aria-label="위로" disabled={i === 0} onClick={(e) => { e.stopPropagation(); move(b.id, -1); }} className="text-muted-foreground disabled:opacity-30 hover:text-foreground"><ArrowUp className="h-3.5 w-3.5" /></button>
                  <button type="button" aria-label="아래로" disabled={i === doc.banners.length - 1} onClick={(e) => { e.stopPropagation(); move(b.id, 1); }} className="text-muted-foreground disabled:opacity-30 hover:text-foreground"><ArrowDown className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            );
          })}
          <Button variant="outline" size="sm" className="w-full h-8 text-xs" onClick={addBanner}>
            <Plus className="h-3.5 w-3.5 mr-1" />새 배너
          </Button>
        </div>

        {/* 편집 + 미리보기 */}
        {selected ? (
          <div className="space-y-4 min-w-0">
            {/* 미리보기 — 메인이 쓰는 BannerSlide 그대로 */}
            <div className="grid grid-cols-1 xl:grid-cols-[1fr_300px] gap-4 items-start">
              <div>
                <p className="text-[11px] text-muted-foreground mb-1">PC 미리보기</p>
                <BannerSlide banner={selected} settings={doc.settings} device="pc" className="rounded-lg border" />
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground mb-1">모바일 미리보기 · {RATIO_LABEL[doc.settings.mobileRatio]}</p>
                <div className="w-[300px] max-w-full">
                  <BannerSlide banner={selected} settings={doc.settings} device="mobile" className="rounded-lg border" />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-xs">
              {/* 기본 */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">관리용 이름</Label>
                  <label className="flex items-center gap-2 text-xs">
                    <Switch checked={selected.enabled} onCheckedChange={(v) => updateBanner(selected.id, { enabled: v })} />
                    노출
                  </label>
                </div>
                <Input className="h-8 text-xs" value={selected.name} onChange={(e) => updateBanner(selected.id, { name: e.target.value })} placeholder="예: 10월 신작 장난감" />

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs">시작 (JST, 비우면 바로)</Label>
                    <Input type="datetime-local" className="h-8 text-xs" value={isoToJstLocal(selected.startAt)} onChange={(e) => updateBanner(selected.id, { startAt: jstLocalToIso(e.target.value) })} />
                  </div>
                  <div>
                    <Label className="text-xs">종료 (JST, 비우면 계속)</Label>
                    <Input type="datetime-local" className="h-8 text-xs" value={isoToJstLocal(selected.endAt)} onChange={(e) => updateBanner(selected.id, { endAt: jstLocalToIso(e.target.value) })} />
                  </div>
                </div>

                <div>
                  <Label className="text-xs">링크 (누르면 가는 곳)</Label>
                  <Input className="h-8 text-xs" value={selected.link ?? ""} onChange={(e) => updateBanner(selected.id, { link: e.target.value || null })} placeholder="https://biteme.co.jp/?collection=…" />
                </div>

                {/* 상품 링크로 — 사진 모드 */}
                <div className="rounded-lg border p-3 space-y-2 bg-muted/20">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-semibold">상품 링크로 만들기</Label>
                    {selected.photo && (
                      <button type="button" className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-0.5" onClick={() => updateBanner(selected.id, { photo: null })}>
                        <X className="h-3 w-3" />상품 사진 빼기
                      </button>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Input
                      className="h-8 text-xs"
                      value={productInput}
                      onChange={(e) => setProductInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") loadProduct(); }}
                      placeholder="https://biteme.co.jp/product/1034661… 또는 숫자 ID"
                    />
                    <Button variant="outline" size="sm" className="h-8 text-xs shrink-0" disabled={productLoading} onClick={loadProduct}>
                      <Search className="h-3.5 w-3.5 mr-1" />{productLoading ? "조회 중…" : "이미지 보기"}
                    </Button>
                  </div>
                  {product && product.images.length > 0 && (
                    <div>
                      <p className="text-[11px] text-muted-foreground mb-1 truncate">{product.title} — 글자 없는 사진을 고르세요</p>
                      <div className="grid grid-cols-6 gap-1.5">
                        {product.images.map((img) => (
                          <button
                            key={img.url}
                            type="button"
                            onClick={() => pickProductImage(img)}
                            className={cn(
                              "aspect-square rounded border overflow-hidden bg-white hover:ring-2 hover:ring-primary/50",
                              selected.photo?.url === img.url && "ring-2 ring-primary",
                            )}
                          >
                            <img src={`${img.url}${img.url.includes("?") ? "&" : "?"}width=160`} alt="" className="w-full h-full object-cover" />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {selected.photo && (
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" className="h-8 text-xs" disabled={cleaning} onClick={cleanPhoto}>
                        <Sparkles className="h-3.5 w-3.5 mr-1" />{cleaning ? "지우는 중… (10~20초)" : "AI 로 글자 지우기"}
                      </Button>
                      <span className="text-[11px] text-muted-foreground">사진은 그대로 두고 글자만 지운 사본을 만듭니다. 마음에 안 들면 위에서 사진을 다시 고르면 원본으로</span>
                    </div>
                  )}
                  {selected.photo && photoCroppable(selected.photo) && (
                    <div className="flex items-center gap-3">
                      <Label className="text-xs shrink-0">위 자르기 {Math.round(selected.photo.cropTop * 100)}%</Label>
                      <Slider
                        className="flex-1"
                        min={0}
                        max={60}
                        step={1}
                        value={[Math.round(selected.photo.cropTop * 100)]}
                        onValueChange={([v]) => selected.photo && updateBanner(selected.id, { photo: { ...selected.photo, cropTop: v / 100 } })}
                      />
                      <span className="text-[11px] text-muted-foreground shrink-0">썸네일 위쪽 제목을 잘라냄</span>
                    </div>
                  )}
                  {selected.photo && <p className="text-[11px] text-muted-foreground">상품 사진이 있으면 아래 PC·모바일 이미지는 안 씁니다.</p>}
                </div>

                <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
                  <div>
                    <Label className="text-xs">PC 이미지 (1200×504)</Label>
                    <Input className="h-8 text-xs" value={selected.pcImage ?? ""} onChange={(e) => updateBanner(selected.id, { pcImage: e.target.value || null })} placeholder="업로드하거나 주소 붙여넣기" />
                  </div>
                  <Button variant="outline" size="sm" className="h-8 text-xs" disabled={uploading !== null} onClick={() => pcFileRef.current?.click()}>
                    <ImagePlus className="h-3.5 w-3.5 mr-1" />{uploading === "pc" ? "올리는 중…" : "업로드"}
                  </Button>
                  <input ref={pcFileRef} type="file" accept="image/*" className="hidden" onChange={(e) => onPickImage("pc", e.target.files?.[0])} />
                </div>

                <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
                  <div>
                    <Label className="text-xs">모바일 이미지 ({doc.settings.mobileRatio === "strip" ? "가로형이라 안 씀" : `${doc.settings.mobileRatio} 권장 · 없으면 PC 이미지를 배경색 위에`})</Label>
                    <Input className="h-8 text-xs" value={selected.mobileImage ?? ""} onChange={(e) => updateBanner(selected.id, { mobileImage: e.target.value || null })} placeholder="선택" disabled={doc.settings.mobileRatio === "strip"} />
                  </div>
                  <Button variant="outline" size="sm" className="h-8 text-xs" disabled={uploading !== null || doc.settings.mobileRatio === "strip"} onClick={() => mobileFileRef.current?.click()}>
                    <ImagePlus className="h-3.5 w-3.5 mr-1" />{uploading === "mobile" ? "올리는 중…" : "업로드"}
                  </Button>
                  <input ref={mobileFileRef} type="file" accept="image/*" className="hidden" onChange={(e) => onPickImage("mobile", e.target.files?.[0])} />
                </div>

                <div className="flex items-center gap-2">
                  <Label className="text-xs">배경색</Label>
                  <input type="color" value={selected.bg} onChange={(e) => updateBanner(selected.id, { bg: e.target.value })} className="h-7 w-10 rounded border cursor-pointer" />
                  <span className="text-muted-foreground">{selected.bg} · PC 이미지 올리면 모서리 색으로 자동</span>
                </div>
              </div>

              {/* 문구 */}
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs">배지 (맨 위 칩)</Label>
                    <Input className="h-8 text-xs" value={selected.text.badge} onChange={(e) => updateText(selected.id, { badge: e.target.value })} placeholder="NEW" />
                  </div>
                  <div>
                    <Label className="text-xs">부제 (작은 글씨)</Label>
                    <Input className="h-8 text-xs" value={selected.text.subtext} onChange={(e) => updateText(selected.id, { subtext: e.target.value })} placeholder="本日発売" />
                  </div>
                </div>
                <div>
                  <Label className="text-xs">헤드라인 (줄바꿈은 Enter)</Label>
                  <Textarea className="text-xs min-h-[60px]" value={selected.text.headline} onChange={(e) => updateText(selected.id, { headline: e.target.value })} placeholder={"遊び方いろいろ！\n新作おもちゃ4アイテム"} />
                </div>
                <div className="grid grid-cols-[1fr_auto_auto] gap-2 items-end">
                  <div>
                    <Label className="text-xs">CTA (아래 고정)</Label>
                    <Input className="h-8 text-xs" value={selected.text.cta} onChange={(e) => updateText(selected.id, { cta: e.target.value })} placeholder="新作を見る" />
                  </div>
                  <div>
                    <Label className="text-xs">모양</Label>
                    <Select value={selected.text.ctaStyle} onValueChange={(v) => updateText(selected.id, { ctaStyle: v as "text" | "button" })}>
                      <SelectTrigger className="h-8 w-24 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="text" className="text-xs">글자만</SelectItem>
                        <SelectItem value="button" className="text-xs">버튼</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">글자색</Label>
                    <Select value={selected.text.tone} onValueChange={(v) => updateText(selected.id, { tone: v as "dark" | "light" })}>
                      <SelectTrigger className="h-8 w-24 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="dark" className="text-xs">검정</SelectItem>
                        <SelectItem value="light" className="text-xs">흰색</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  문구를 전부 비우면 이미지만 나갑니다(글자가 박힌 배너). 자리는 고정 — 배지·부제·헤드라인은 위에서 아래로,
                  CTA 는 헤드라인 길이와 상관없이 늘 아래 같은 자리.
                </p>

                <div className="flex gap-2 pt-2">
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => duplicateBanner(selected.id)}>
                    <Copy className="h-3.5 w-3.5 mr-1" />복제
                  </Button>
                  <Button variant="outline" size="sm" className="h-8 text-xs text-red-600 hover:text-red-700" onClick={() => removeBanner(selected.id)}>
                    <Trash2 className="h-3.5 w-3.5 mr-1" />삭제
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground py-8 text-center">왼쪽에서 배너를 고르거나 「새 배너」</p>
        )}
      </div>
    </div>
  );
}
