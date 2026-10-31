import os
import math
import re
import sys
import json
from datetime import datetime, timezone
import pandas as pd
from fastapi import FastAPI, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from routers import admin
from services.admin_service import demo_admin_enabled
from services.smartmeal_model import model_metadata, predict_fit

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

app = FastAPI(title="FoodLens API", version="1.0")

# Register modular routers *after* app is initialized
app.include_router(admin.router)

cors_origins = [value.strip() for value in os.getenv("CORS_ORIGIN", "http://localhost:5173,http://127.0.0.1:5173").split(",") if value.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["content-type"],
)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_PATH = os.path.join(SCRIPT_DIR, "data", "canonical_master_view.csv")

def load_data(path=DATA_PATH):
    if not os.path.exists(path):
        return pd.DataFrame()
    try:
        df = pd.read_csv(path)
    except Exception as error:
        raise HTTPException(status_code=503, detail=f"Dataset could not be read ({type(error).__name__}).") from error
    df = df.astype(object).where(df.notnull(), None)
    return df

def load_all():
    data_dir = os.path.join(SCRIPT_DIR, "data")
    filenames = ("canonical_restaurants.csv", "provider_restaurants.csv", "provider_menu_items.csv", "provider_offers.csv", "reviews.csv")
    frames = []
    for filename in filenames:
        path = os.path.join(data_dir, filename)
        if not os.path.exists(path):
            raise HTTPException(status_code=503, detail=f"Required dataset is unavailable: {filename}.")
        try:
            frames.append(pd.read_csv(path))
        except Exception as error:
            raise HTTPException(status_code=503, detail=f"Required dataset could not be read: {filename} ({type(error).__name__}).") from error
    return tuple(frames)

def _text(value, default=""):
    return default if value is None or pd.isna(value) else str(value).strip()

def _number(value, default=None):
    return default if value is None or pd.isna(value) else float(value)

def _boolean(value, default=False):
    if value is None or pd.isna(value):
        return default
    if isinstance(value, str):
        return value.strip().casefold() in {"true", "1", "yes", "available", "active"}
    return bool(value)

def _provider_id(value):
    return re.sub(r"[^a-z0-9]+", "-", _text(value, "unknown").casefold()).strip("-") or "unknown"

def _freshness(value):
    timestamp = pd.to_datetime(value, errors="coerce", utc=True)
    if pd.isna(timestamp):
        return {"ageMin": None, "status": "stale"}
    age_min = max(0, int((datetime.now(timezone.utc) - timestamp.to_pydatetime()).total_seconds() / 60))
    status = "stale" if age_min > 1440 else ("aging" if age_min > 180 else "fresh")
    return {"ageMin": age_min, "status": status}

def _sentiment_aggregate(reviews_df, column):
    if reviews_df.empty or column not in reviews_df.columns:
        return {"score": None, "mentions": 0, "enough": False}
    values = reviews_df[column].fillna("").astype(str).str.casefold()
    expressed = values[values.isin(["positive", "negative"])]
    mentions = len(expressed)
    if not mentions:
        return {"score": None, "mentions": 0, "enough": False}
    # Shrink sparse positive/negative labels toward a neutral 0.5 baseline.
    positive_share = float((expressed == "positive").mean())
    score = 0.5 + (positive_share - 0.5) * (mentions / (mentions + 2))
    return {"score": round(score, 3), "mentions": mentions, "enough": mentions >= 3}

def _deduplicate_review_text(reviews_df):
    """Keep one source row per normalized review text; retain blank-text rows by ID."""
    if reviews_df.empty or "review_text" not in reviews_df.columns:
        return reviews_df.copy()
    normalized = reviews_df["review_text"].fillna("").astype(str).str.casefold().str.replace(r"\s+", " ", regex=True).str.strip()
    keys = normalized.where(normalized.ne(""), reviews_df.get("review_id", reviews_df.index).astype(str))
    return reviews_df.loc[~keys.duplicated(keep="first")].copy()

def compute_reputation(listing_id, providers_df, reviews_df):
    prov_row = providers_df[providers_df['listing_id'] == listing_id]
    if prov_row.empty:
        return {"adjusted_rating": 3.9, "delivery_sentiment": 0.5, "evidence_level": "low"}
        
    row = prov_row.iloc[0]
    raw_rating = row.get('rating', 3.9)
    if pd.isna(raw_rating):
        raw_rating = 3.9
    n = row.get('rating_count', 30)
    if pd.isna(n):
        n = 30
        
    # Rating shrinkage toward prior 3.9
    adjusted_rating = (n * raw_rating + 30 * 3.9) / (n + 30)
    
    # Delivery sentiment from reviews
    listing_reviews = reviews_df[reviews_df['listing_id'] == listing_id]
    if not listing_reviews.empty and 'delivery_sentiment' in listing_reviews.columns:
        valid_sent = listing_reviews['delivery_sentiment'].dropna()
        if len(valid_sent) > 0:
            delivery_sentiment = (valid_sent == 'positive').mean()
        else:
            delivery_sentiment = 0.5
    else:
        delivery_sentiment = 0.5
        
    evidence_level = "high" if n >= 500 and len(listing_reviews) >= 10 else ("medium" if n >= 100 else "low")
    
    return {
        "raw_rating": raw_rating,
        "rating_count": n,
        "adjusted_rating": round(float(adjusted_rating), 2),
        "delivery_sentiment": round(float(delivery_sentiment), 2),
        "evidence_level": evidence_level
    }

def price_basket(listing_id, selections, menus_df, offers_df, providers_df):
    prov_row = providers_df[providers_df['listing_id'] == listing_id]
    if prov_row.empty:
        return {"available": False, "reason": "Listing not found"}
        
    listing_menus = menus_df[menus_df['listing_id'] == listing_id]
    
    subtotal = 0.0
    missing_items = []
    
    for sel in selections:
        q = int(sel.get('quantity', sel.get('qty', 1)))
        item_query = str(sel.get('item_name', sel.get('itemId', ''))).strip().casefold()
        if not item_query or q < 1 or q > 20:
            missing_items.append(item_query or "invalid basket selection")
            continue

        normalized = listing_menus.get("normalized_item_name", listing_menus["item_name"]).fillna("").astype(str).str.casefold()
        match = listing_menus[normalized == item_query]
        if match.empty:
            match = listing_menus[listing_menus["item_name"].fillna("").astype(str).str.casefold() == item_query]
            
        if match.empty:
            missing_items.append(item_query)
        else:
            m_row = match.iloc[0]
            is_avail = _boolean(m_row.get('is_available'), False)
            if not is_avail:
                missing_items.append(f"{m_row['item_name']} (unavailable)")
            else:
                price = m_row.get('price_inr', 0.0)
                if pd.isna(price):
                    missing_items.append(f"{m_row['item_name']} (price unknown)")
                else:
                    subtotal += float(price) * q
                
    if missing_items:
        return {
            "available": False,
            "missing_items": missing_items,
            "reason": f"Missing or unavailable items: {', '.join(missing_items)}"
        }
        
    food_gst = 0.05 * subtotal
    provider_row = prov_row.iloc[0]
    delivery_fee = _number(provider_row.get("delivery_fee_inr", provider_row.get("delivery_fee")))
    platform_fee = _number(provider_row.get("platform_fee_inr", provider_row.get("platform_fee")))
    known_fee_total = sum(value for value in (delivery_fee, platform_fee) if value is not None)
    gst_on_fees = 0.18 * known_fee_total
    
    listing_offers = offers_df[offers_df['listing_id'] == listing_id] if "listing_id" in offers_df.columns else pd.DataFrame()
    max_discount = 0.0
    applied_offer_title = None
    
    today = pd.Timestamp.now(tz="UTC").date()
    for _, offer in listing_offers.iterrows():
        if _text(offer.get("offer_status"), "active").casefold() not in {"active", "valid", ""}:
            continue
        valid_from = pd.to_datetime(offer.get("valid_from"), errors="coerce")
        valid_until = pd.to_datetime(offer.get("valid_until"), errors="coerce")
        if pd.notna(valid_from) and valid_from.date() > today:
            continue
        if pd.notna(valid_until) and valid_until.date() < today:
            continue
        min_ord = offer.get('minimum_order_value_inr')
        disc_val = offer.get('discount_value')
        if pd.isna(min_ord) or pd.isna(disc_val) or subtotal < float(min_ord) or float(disc_val) <= 0:
            continue
        disc_type = _text(offer.get('discount_type')).casefold()
        if disc_type in {'percentage', 'percent'}:
            max_cap = offer.get('maximum_discount_inr')
            if pd.isna(max_cap):
                continue
            disc = min(float(max_cap), subtotal * (float(disc_val) / 100.0))
        elif disc_type in {'flat_amount', 'flat', 'amount'}:
            disc = float(disc_val)
            max_cap = offer.get('maximum_discount_inr')
            if pd.notna(max_cap):
                disc = min(float(max_cap), disc)
        else:
            continue
        if disc > max_discount:
            max_discount = disc
            applied_offer_title = offer.get('offer_title')
                
    total = max(0.0, subtotal + food_gst + known_fee_total + gst_on_fees - max_discount)
    
    return {
        "available": True,
        "subtotal": round(subtotal, 2),
        "food_gst": round(food_gst, 2),
        "delivery_fee": delivery_fee,
        "platform_fee": platform_fee,
        "gst_on_fees": round(gst_on_fees, 2),
        "discount": round(max_discount, 2),
        "applied_offer": applied_offer_title,
        "total": round(total, 2),
        "is_lower_bound": delivery_fee is None or platform_fee is None,
        "unknowns": [fee for fee, value in (("delivery fee", delivery_fee), ("platform fee", platform_fee)) if value is None],
    }

@app.get("/")
def read_root():
    return {"message": "Welcome to FoodLens API! 🚀", "status": "active"}

@app.get("/health")
@app.get("/api/health")
def get_health():
    return {"status": "ok", "service": "foodlens-python"}

@app.get("/api/restaurants")
def get_restaurants(limit: int = 20, search: str = None):
    df = load_data(DATA_PATH)
    if df.empty:
        raise HTTPException(status_code=404, detail="Dataset not found")
    
    if search:
        name_mask = df['restaurant_name'].astype(str).str.contains(search, case=False, na=False)
        canon_mask = df['canonical_name'].astype(str).str.contains(search, case=False, na=False) if 'canonical_name' in df.columns else False
        df = df[name_mask | canon_mask]
        
    results = df.head(limit).to_dict(orient="records")
    return {"total": len(df), "results": results}

@app.get("/api/restaurants/{listing_id}")
def get_restaurant_detail(listing_id: str):
    canonical, providers, menus, offers, reviews = load_all()
    if canonical.empty or providers.empty:
        raise HTTPException(status_code=404, detail="Restaurant datasets are unavailable")

    listing_match = providers[providers["listing_id"].astype(str) == listing_id]
    master = load_data(DATA_PATH)
    if not listing_match.empty:
        linked_id = _text(listing_match.iloc[0].get("canonical_restaurant_id"))
        if linked_id:
            canonical_id = linked_id
            canonical_match = canonical[canonical["canonical_restaurant_id"].astype(str) == canonical_id]
            restaurant = canonical_match.iloc[0] if not canonical_match.empty else None
            listings = providers[providers["canonical_restaurant_id"].astype(str) == canonical_id].copy()
        else:
            # Unmatched single-provider records have no canonical row; keep each listing independent.
            canonical_id = listing_id
            row_match = master[master["listing_id"].astype(str) == listing_id]
            restaurant = row_match.iloc[0] if not row_match.empty else listing_match.iloc[0]
            listings = listing_match.copy()
    else:
        canonical_id = listing_id
        canonical_match = canonical[canonical["canonical_restaurant_id"].astype(str) == canonical_id]
        if canonical_match.empty:
            raise HTTPException(status_code=404, detail="Restaurant not found")
        restaurant = canonical_match.iloc[0]
        listings = providers[providers["canonical_restaurant_id"].astype(str) == canonical_id].copy()
    if listings.empty:
        raise HTTPException(status_code=404, detail="Restaurant has no provider listings")
    listing_ids = set(listings["listing_id"].astype(str))
    restaurant_menus = menus[menus["listing_id"].astype(str).isin(listing_ids)].copy()
    restaurant_reviews = reviews[reviews["listing_id"].astype(str).isin(listing_ids)].copy()

    detail_listings = []
    for _, row in listings.iterrows():
        source_id = str(row["listing_id"])
        detail_listings.append({
            "providerId": _provider_id(row.get("provider")),
            "providerName": _text(row.get("provider"), "Unknown provider"),
            "recordId": _text(row.get("provider_restaurant_id"), source_id),
            "providerListingName": _text(row.get("restaurant_name"), "Unknown listing"),
            "etaMin": _number(row.get("average_delivery_time_minutes")),
            "deliveryFee": _number(row.get("delivery_fee_inr", row.get("delivery_fee"))),
            "platformFee": _number(row.get("platform_fee_inr", row.get("platform_fee"))),
            "rating": _number(row.get("rating")),
            "ratingCount": _number(row.get("rating_count")),
            "url": "",
            "fetchedAt": _text(row.get("source_updated_at")),
            "freshness": _freshness(row.get("source_updated_at")),
        })

    if not restaurant_menus.empty:
        restaurant_menus["normalized_item_name"] = restaurant_menus.get("normalized_item_name", restaurant_menus["item_name"]).fillna("").astype(str).str.casefold()
    items = []
    for item_key, item_rows in restaurant_menus.groupby("normalized_item_name", sort=True, dropna=False):
        if not _text(item_key):
            continue
        first_item = item_rows.iloc[0]
        item_offers = []
        for _, item_row in item_rows.iterrows():
            provider_row = listings[listings["listing_id"].astype(str) == str(item_row["listing_id"])].iloc[0]
            item_offers.append({
                "providerId": _provider_id(provider_row.get("provider")),
                "providerName": _text(provider_row.get("provider"), "Unknown provider"),
                "providerItemName": _text(item_row.get("item_name")),
                "price": _number(item_row.get("price_inr")),
                "available": _boolean(item_row.get("is_available"), False),
            })
        items.append({
            "id": str(item_key),
            "name": _text(first_item.get("item_name"), str(item_key)),
            "veg": all(_boolean(value, False) for value in item_rows.get("is_vegetarian", pd.Series(dtype=object)).tolist()),
            "vegetarian": all(_boolean(value, False) for value in item_rows.get("is_vegetarian", pd.Series(dtype=object)).tolist()),
            "portion": "unknown",
            "offers": item_offers,
        })

    # Use listing ratings with Bayesian shrinkage; sentiment labels remain separate evidence.
    per_source = []
    weighted_rating = 0.0
    weight_total = 0.0
    for _, row in listings.iterrows():
        raw_rating = _number(row.get("rating"))
        count = _number(row.get("rating_count"), 0.0) or 0.0
        if raw_rating is None:
            continue
        adjusted = (count * raw_rating + 30 * 3.9) / (count + 30)
        provider_id = _provider_id(row.get("provider"))
        per_source.append({"providerId": provider_id, "raw": raw_rating, "count": int(count), "adjusted": round(adjusted, 2)})
        # Log weighting prevents one very large provider count from fully
        # drowning out another source while still using the available volume.
        source_weight = math.log1p(max(count, 0))
        weighted_rating += adjusted * source_weight
        weight_total += source_weight
    combined_rating = round(weighted_rating / weight_total, 2) if weight_total else None

    unique_reviews = _deduplicate_review_text(restaurant_reviews)
    aspects = {
        "food": _sentiment_aggregate(unique_reviews, "food_sentiment"),
        "delivery": _sentiment_aggregate(unique_reviews, "delivery_sentiment"),
        "service": _sentiment_aggregate(unique_reviews, "service_sentiment"),
        "value": {"score": None, "mentions": 0, "enough": False},
    }
    provider_delivery = {}
    for _, row in listings.iterrows():
        provider_id = _provider_id(row.get("provider"))
        provider_listing_reviews = unique_reviews[unique_reviews["listing_id"].astype(str) == str(row["listing_id"])]
        provider_delivery[provider_id] = _sentiment_aggregate(provider_listing_reviews, "delivery_sentiment")

    positive_highlights = []
    negative_highlights = []
    for _, review in unique_reviews.iterrows():
        for column, sentiment, target, aspect in (
            ("food_sentiment", "positive", positive_highlights, "food"),
            ("food_sentiment", "negative", negative_highlights, "food"),
            ("delivery_sentiment", "positive", positive_highlights, "delivery"),
            ("delivery_sentiment", "negative", negative_highlights, "delivery"),
            ("service_sentiment", "positive", positive_highlights, "service"),
            ("service_sentiment", "negative", negative_highlights, "service"),
        ):
            if _text(review.get(column)).casefold() == sentiment and len(target) < 3:
                snippet = _text(review.get("review_text"))[:180]
                if snippet:
                    target.append({"aspect": aspect, "snippet": snippet, "providerId": _provider_id(review.get("provider"))})
    total_rating_count = sum(_number(row.get("rating_count"), 0) or 0 for _, row in listings.iterrows())
    evidence = "high" if total_rating_count >= 500 and len(unique_reviews) >= 10 else ("medium" if total_rating_count >= 100 else "low")
    food_score = aspects["food"]["score"]
    food_quality = None
    if combined_rating is not None:
        if food_score is not None and aspects["food"]["mentions"] >= 3:
            food_quality = {"value": round(0.7 * combined_rating + 0.3 * (1 + 4 * food_score), 2), "basis": "70% adjusted provider rating and 30% smoothed food sentiment (at least 3 labeled mentions)"}
        else:
            food_quality = {"value": combined_rating, "basis": "adjusted provider rating; food sentiment has fewer than 3 labeled mentions"}
    reputation = {
        "evidence": evidence,
        "reviewsAnalyzed": len(unique_reviews),
        "duplicatesRemoved": len(restaurant_reviews) - len(unique_reviews),
        "method": "Bayesian rating shrinkage toward 3.9, log(1 + rating count) source weighting, and smoothed supplied sentiment labels",
        "disclaimer": "Synthetic demonstration data; sentiment labels are provided with the dataset, not independently verified.",
        "rating": {"combined": combined_rating, "perSource": per_source},
        "foodQuality": food_quality,
        "aspects": aspects,
        "providerDelivery": provider_delivery,
        "highlights": {"positive": positive_highlights, "negative": negative_highlights},
    }

    conflicts = []
    name_variants = sorted(set(listings["restaurant_name"].dropna().astype(str)))
    if len(name_variants) > 1:
        conflicts.append({"attribute": "provider name", "severity": "info", "detail": "Provider listings use different names: " + ", ".join(name_variants), "policy": "Keep provider names attached to their source listings."})
    observations = []
    observation_fields = (("rating", "rating"), ("ratingCount", "rating_count"), ("averagePriceInr", "average_price_inr"), ("etaMin", "average_delivery_time_minutes"), ("identityConfidence", "identity_confidence"))
    for _, row in listings.iterrows():
        provider_id = _provider_id(row.get("provider"))
        observed_at = _text(row.get("source_updated_at"))
        confidence = _number(row.get("identity_confidence"), 0.0) or 0.0
        for attribute, column in observation_fields:
            if column in listings.columns:
                observations.append({"attribute": attribute, "value": _number(row.get(column)), "providerId": provider_id, "observedAt": observed_at, "confidence": confidence})

    cuisine_value = _text(restaurant.get("canonical_cuisine")) or _text(restaurant.get("cuisines"))
    cuisines = sorted({part.strip() for part in cuisine_value.split(",") if part.strip()})
    area = _text(restaurant.get("locality")) or _text(restaurant.get("locality_canon")) or _text(restaurant.get("locality_prov")) or _text(restaurant.get("city")) or _text(restaurant.get("city_canon")) or _text(restaurant.get("city_prov"))
    return {
        "id": str(canonical_id),
        "name": _text(restaurant.get("canonical_name")) or _text(restaurant.get("restaurant_name"), str(canonical_id)),
        "area": area,
        "phone": None,
        "cuisines": cuisines,
        "listings": detail_listings,
        "items": items,
        "reputation": reputation,
        "conflicts": conflicts,
        "observations": observations,
    }

@app.get("/api/meta")
def get_meta():
    df = load_data(DATA_PATH)
    if df.empty:
        return {"dataMode": "synthetic", "notice": "Synthetic demonstration data only.", "providers": [], "cuisines": [], "adminDemoEnabled": demo_admin_enabled()}
    
    provider_names = df['provider'].dropna().astype(str).unique().tolist() if 'provider' in df.columns else []
    providers = [{"id": _provider_id(name), "name": name} for name in provider_names]
    canonical_path = os.path.join(SCRIPT_DIR, "data", "canonical_restaurants.csv")
    canonical = load_data(canonical_path)
    cuisine_values = canonical.get("canonical_cuisine", pd.Series(dtype=str)).dropna().astype(str)
    cuisines = sorted({part.strip() for value in cuisine_values for part in value.split(",") if part.strip()})
    synthetic_values = df.get("is_synthetic_prov", pd.Series([True]))
    synthetic = all(_boolean(value, True) for value in synthetic_values)
    provider_path = os.path.join(SCRIPT_DIR, "data", "provider_restaurants.csv")
    try:
        locations = pd.read_csv(provider_path).fillna("")
        cities = sorted({str(value).strip() for value in locations.get("city", pd.Series(dtype=str)).tolist() if str(value).strip()})
        areas = sorted({str(value).strip() for value in locations.get("locality", pd.Series(dtype=str)).tolist() if str(value).strip()})
    except Exception:
        cities, areas = [], []
    
    return {
        "dataMode": "synthetic" if synthetic else "mixed",
        "notice": "Synthetic demonstration data only. Provider prices, availability, fees, and ratings are not live or verified.",
        "providers": providers,
        "cuisines": cuisines,
        "cities": cities,
        "areas": areas,
        "adminDemoEnabled": demo_admin_enabled(),
    }

@app.get("/api/search")
def search_restaurants(q: str = "", cuisine: str = "", provider: str = "", city: str = "", area: str = "", limit: int = 100,
                      page: int = 1, pageSize: int | None = None, minRating: float | None = None, maxEta: float | None = None):
    """Return the canonical search-card contract consumed by the React app."""
    if page < 1:
        raise HTTPException(status_code=400, detail="page must be at least 1.")
    if pageSize is not None and not 1 <= pageSize <= 50:
        raise HTTPException(status_code=400, detail="pageSize must be between 1 and 50.")
    if minRating is not None and (not math.isfinite(minRating) or minRating < 0 or minRating > 5):
        raise HTTPException(status_code=400, detail="minRating must be between 0 and 5.")
    if maxEta is not None and (not math.isfinite(maxEta) or maxEta <= 0):
        raise HTTPException(status_code=400, detail="maxEta must be positive.")
    df = load_data(DATA_PATH)
    if df.empty:
        return {"total": 0, "results": [], "page": page, "pageSize": pageSize or limit}

    menus_path = os.path.join(SCRIPT_DIR, "data", "provider_menu_items.csv")
    menus = pd.read_csv(menus_path) if os.path.exists(menus_path) else pd.DataFrame()
    q_tokens = re.findall(r"[a-z0-9]+", q.strip().casefold())
    cuisine_text = cuisine.strip().casefold()
    provider_text = provider.strip().casefold()
    city_text = city.strip().casefold()
    area_text = area.strip().casefold()
    if not menus.empty:
        menus["normalized_item_name"] = menus.get("normalized_item_name", menus["item_name"]).fillna("").astype(str)

    df["_search_group"] = df["canonical_restaurant_id"].where(df["canonical_restaurant_id"].notna(), df["listing_id"])
    results = []
    for search_group_id, group in df.groupby("_search_group", sort=False, dropna=False):
        if provider_text:
            group = group[group["provider"].fillna("").astype(str).str.contains(provider_text, case=False, regex=False)]
            if group.empty:
                continue
        first = group.iloc[0]
        listing_ids = set(group["listing_id"].dropna().astype(str))
        canonical_id = _text(first.get("canonical_restaurant_id")) or str(search_group_id)
        name = _text(first.get("canonical_name")) or _text(first.get("restaurant_name"), "Unknown restaurant")
        area = first.get("locality_canon") or first.get("locality_prov") or first.get("city_canon") or first.get("city_prov") or ""
        cuisine_values = group.get("canonical_cuisine", pd.Series(dtype=str)).dropna().astype(str)
        if not len(cuisine_values):
            cuisine_values = group.get("cuisines", pd.Series(dtype=str)).dropna().astype(str)
        cuisines = sorted({part.strip() for value in cuisine_values for part in value.split(",") if part.strip()})

        listing_names = " ".join(group.get("restaurant_name", pd.Series(dtype=str)).fillna("").astype(str))
        menu_rows = menus[menus["listing_id"].astype(str).isin(listing_ids)] if not menus.empty else menus
        menu_names = " ".join(menu_rows.get("item_name", pd.Series(dtype=str)).fillna("").astype(str))
        name_text = name.casefold()
        cuisine_texts = [value.casefold() for value in cuisines]
        listing_text = listing_names.casefold()
        menu_text = menu_names.casefold()
        relevance = 0
        if any(token not in " ".join((name_text, " ".join(cuisine_texts), listing_text, menu_text)) for token in q_tokens):
            continue
        for token in q_tokens:
            relevance += 3 if token in name_text or token in listing_text else (2 if any(token in value for value in cuisine_texts) else 1)
        if cuisine_text and not any(cuisine_text in value.casefold() for value in cuisines):
            continue
        cities = []
        for city_column in ("city_canon", "city_prov"):
            if city_column in group.columns:
                cities.extend(group[city_column].dropna().astype(str).tolist())
        if city_text and city_text not in " ".join(cities).casefold() and city_text not in str(area).casefold():
            continue
        localities = []
        for locality_column in ("locality_canon", "locality_prov"):
            if locality_column in group.columns:
                localities.extend(group[locality_column].dropna().astype(str).tolist())
        if area_text and not any(area_text in locality.casefold() for locality in localities):
            continue

        providers = []
        rating_weighted = 0.0
        rating_count = 0.0
        for _, row in group.iterrows():
            provider_name = str(row.get("provider") or "Unknown")
            eta = row.get("average_delivery_time_minutes")
            eta = float(eta) if pd.notna(eta) else None
            updated = pd.to_datetime(row.get("source_updated_at"), errors="coerce", utc=True)
            age_min = max(0, int((datetime.now(timezone.utc) - updated.to_pydatetime()).total_seconds() / 60)) if pd.notna(updated) else None
            freshness = {"ageMin": age_min, "status": "stale" if age_min is None or age_min > 1440 else ("aging" if age_min > 180 else "fresh")}
            providers.append({"id": str(row.get("listing_id")), "name": provider_name, "etaMin": eta, "freshness": freshness})
            rating = row.get("rating")
            count = row.get("rating_count")
            if pd.notna(rating) and pd.notna(count) and float(count) > 0:
                rating_weighted += float(rating) * float(count)
                rating_count += float(count)
        if not providers:
            continue

        grouped_items = {}
        for _, item in menu_rows.iterrows():
            item_key = str(item.get("normalized_item_name") or item.get("item_name") or "").strip().casefold()
            if not item_key:
                continue
            entry = grouped_items.setdefault(item_key, {"name": str(item.get("item_name") or item_key), "prices": [], "providers": set()})
            price = item.get("price_inr")
            if _boolean(item.get("is_available"), False) and pd.notna(price):
                entry["prices"].append(float(price))
                entry["providers"].add(str(item.get("provider") or ""))
        matched_items = [{"name": item["name"], "minPrice": round(min(item["prices"]), 2) if item["prices"] else None,
                          "maxPrice": round(max(item["prices"]), 2) if item["prices"] else None, "providers": len(item["providers"])}
                         for item in grouped_items.values()]
        if q_tokens and not any(token in name_text or token in listing_text for token in q_tokens):
            dish_matches = [item for item in matched_items if any(token in item["name"].casefold() for token in q_tokens)]
            if dish_matches:
                matched_items = dish_matches
        combined = round(rating_weighted / rating_count, 2) if rating_count else None
        if minRating is not None and combined is not None and combined < minRating:
            continue
        if maxEta is not None:
            providers = [item for item in providers if item["etaMin"] is None or item["etaMin"] <= maxEta]
            if not providers:
                continue
        evidence = "high" if rating_count >= 1000 else ("medium" if rating_count >= 100 else "low")
        results.append({"id": str(canonical_id), "name": name, "area": str(area), "cuisines": cuisines,
                        "rating": {"combined": combined, "evidence": evidence}, "matchedItems": matched_items,
                        "providers": providers, "_relevance": relevance})

    results.sort(key=lambda result: (-result["_relevance"], result["rating"]["combined"] is None, -(result["rating"]["combined"] or 0), result["name"].casefold()))
    effective_page_size = pageSize if pageSize is not None else max(1, min(int(limit), 100))
    offset = (page - 1) * effective_page_size
    page_results = results[offset:offset + effective_page_size]
    for result in page_results:
        result.pop("_relevance", None)
    return {"total": len(results), "page": page, "pageSize": effective_page_size, "results": page_results}

@app.get("/api/intelligence/recommendations")
def get_intelligent_recommendations(
    limit: int = 10,
    budgetPerPerson: float | None = None,
    people: int = 1,
    vegetarian: bool | None = None,
    cuisine: str = "",
    priority: str = "value",
    city: str = "",
    area: str = "",
    behaviorSignals: str = "",
    maxDeliveryTime: int | None = None,
):
    """Rank real CSV menu offers using request preferences and explain each result."""
    if not 1 <= limit <= 50:
        raise HTTPException(status_code=400, detail="limit must be between 1 and 50.")
    if people < 1 or people > 12:
        raise HTTPException(status_code=400, detail="people must be between 1 and 12.")
    if budgetPerPerson is not None and (not math.isfinite(budgetPerPerson) or budgetPerPerson <= 0):
        raise HTTPException(status_code=400, detail="budgetPerPerson must be positive.")
    if maxDeliveryTime is not None and not 1 <= maxDeliveryTime <= 240:
        raise HTTPException(status_code=400, detail="maxDeliveryTime must be between 1 and 240 minutes.")

    priority = priority.casefold().replace(" ", "_")
    if priority == "balanced":
        priority = "value"
    weights_by_priority = {
        "value": {"cost": 0.40, "eta": 0.20, "reliability": 0.25, "rating": 0.15},
        "cheapest": {"cost": 0.70, "eta": 0.10, "reliability": 0.10, "rating": 0.10},
        "fastest": {"cost": 0.10, "eta": 0.70, "reliability": 0.10, "rating": 0.10},
        "reliable": {"cost": 0.10, "eta": 0.15, "reliability": 0.65, "rating": 0.10},
        "rated": {"cost": 0.10, "eta": 0.10, "reliability": 0.20, "rating": 0.60},
    }
    if priority not in weights_by_priority:
        raise HTTPException(status_code=400, detail="priority must be value, cheapest, fastest, reliable, or rated.")

    canonical, providers, menus, _, reviews = load_all()
    reviews = _deduplicate_review_text(reviews)
    if providers.empty or menus.empty:
        raise HTTPException(status_code=503, detail="Restaurant and menu datasets are unavailable.")
    weights = weights_by_priority[priority]
    menus = menus.copy()
    menus["normalized_item_name"] = menus.get("normalized_item_name", menus["item_name"]).fillna("").astype(str).str.strip().str.casefold()
    providers = providers.copy()
    providers["_group_id"] = providers["canonical_restaurant_id"].where(providers["canonical_restaurant_id"].notna(), providers["listing_id"])
    budget_total = budgetPerPerson * people if budgetPerPerson is not None else None
    cuisine_query = cuisine.strip().casefold()
    city_query = city.strip().casefold()
    area_query = area.strip().casefold()
    requested_area = area.strip()
    try:
        parsed_signals = json.loads(behaviorSignals) if behaviorSignals else []
        if not isinstance(parsed_signals, list):
            raise ValueError("expected a list")
        behavior_signals = {}
        for item in parsed_signals:
            if not isinstance(item, dict) or not item.get("cuisine"):
                raise ValueError("invalid signal")
            count = int(item.get("count", 0))
            if count < 0:
                raise ValueError("invalid count")
            if count >= 3:
                behavior_signals[str(item["cuisine"]).strip().casefold()] = count
    except (TypeError, ValueError, json.JSONDecodeError):
        raise HTTPException(status_code=400, detail="behaviorSignals must be a valid list of consented cuisine counts.")
    if len(parsed_signals) > 12 or len(behavior_signals) > 12:
        raise HTTPException(status_code=400, detail="Too many behavior signals were supplied.")
    candidates = []
    canonical_rows = canonical.set_index("canonical_restaurant_id", drop=False) if "canonical_restaurant_id" in canonical.columns else pd.DataFrame()

    for group_id, restaurant_listings in providers.groupby("_group_id", sort=False, dropna=False):
        first = restaurant_listings.iloc[0]
        restaurant_id = _text(first.get("canonical_restaurant_id")) or _text(group_id)
        canonical_row = canonical_rows.loc[restaurant_id] if restaurant_id in canonical_rows.index else None
        restaurant_name = _text(canonical_row.get("canonical_name")) if canonical_row is not None else ""
        restaurant_name = restaurant_name or _text(first.get("restaurant_name"), restaurant_id)
        cuisine_source = canonical_row.get("canonical_cuisine") if canonical_row is not None else first.get("cuisines")
        cuisines = sorted({part.strip() for value in ([cuisine_source] if isinstance(cuisine_source, str) else restaurant_listings.get("cuisines", pd.Series(dtype=str)).dropna().astype(str)) for part in str(value).split(",") if part.strip()})
        area = (_text(canonical_row.get("locality")) or _text(canonical_row.get("city"))) if canonical_row is not None else (_text(first.get("locality")) or _text(first.get("city")))
        city_values = restaurant_listings.get("city", pd.Series(dtype=str)).dropna().astype(str).tolist()
        if canonical_row is not None:
            city_values.append(_text(canonical_row.get("city")))
        locality_values = restaurant_listings.get("locality", pd.Series(dtype=str)).dropna().astype(str).tolist()
        if canonical_row is not None:
            locality_values.append(_text(canonical_row.get("locality")))
        if city_query and not any(city_query in value.casefold() for value in city_values):
            continue
        if area_query and not any(area_query in value.casefold() for value in locality_values):
            continue
        if cuisine_query and not any(cuisine_query in value.casefold() for value in cuisines):
            continue

        listing_ids = set(restaurant_listings["listing_id"].astype(str))
        restaurant_menus = menus[menus["listing_id"].astype(str).isin(listing_ids)]
        seen_offers = set()
        for _, menu in restaurant_menus.iterrows():
            item_id = _text(menu.get("normalized_item_name"))
            item_name = _text(menu.get("item_name"), item_id)
            if not item_id or not _boolean(menu.get("is_available"), False):
                continue
            is_vegetarian = _boolean(menu.get("is_vegetarian"), False)
            if vegetarian is True and not is_vegetarian:
                continue
            unit_price = _number(menu.get("price_inr"))
            if unit_price is None or unit_price <= 0:
                continue
            total_price = round(unit_price * people, 2)
            if budget_total is not None and total_price > budget_total:
                continue
            listing_id = _text(menu.get("listing_id"))
            offer_key = (restaurant_id, item_id, listing_id)
            if offer_key in seen_offers:
                continue
            seen_offers.add(offer_key)
            listing_rows = restaurant_listings[restaurant_listings["listing_id"].astype(str) == listing_id]
            if listing_rows.empty:
                continue
            listing = listing_rows.iloc[0]
            eta = _number(listing.get("average_delivery_time_minutes"))
            if maxDeliveryTime is not None and (eta is None or eta > maxDeliveryTime):
                continue
            raw_rating = _number(listing.get("rating"))
            rating_count = _number(listing.get("rating_count"), 0) or 0
            adjusted_rating = ((rating_count * raw_rating + 30 * 3.9) / (rating_count + 30)) if raw_rating is not None and rating_count > 0 else None
            listing_reviews = reviews[reviews["listing_id"].astype(str) == listing_id] if not reviews.empty else pd.DataFrame()
            delivery = listing_reviews.get("delivery_sentiment", pd.Series(dtype=str)).fillna("").astype(str).str.casefold()
            delivery = delivery[delivery.isin(["positive", "neutral", "negative"])]
            reliability = float((delivery == "positive").mean()) if len(delivery) >= 3 else None
            candidates.append({
                "id": f"{restaurant_id}:{item_id}:{listing_id}",
                "restaurantId": restaurant_id,
                "restaurantName": restaurant_name,
                "area": area,
                "cuisines": cuisines,
                "itemId": item_id,
                "itemName": item_name,
                "vegetarian": is_vegetarian,
                "unitPrice": round(unit_price, 2),
                "estimatedSubtotal": total_price,
                "people": people,
                "providerId": _provider_id(listing.get("provider")),
                "providerName": _text(listing.get("provider"), "Unknown provider"),
                "etaMin": eta,
                "freshness": _freshness(listing.get("source_updated_at")),
                "rating": round(adjusted_rating, 2) if adjusted_rating is not None else None,
                "ratingCount": int(rating_count),
                "reliability": reliability,
                "reliabilityMentions": len(delivery),
                "behaviorCuisineCount": max((count for signal_cuisine, count in behavior_signals.items()
                    if any(signal_cuisine in value.casefold() or value.casefold() in signal_cuisine for value in cuisines)), default=0),
            })

    if not candidates:
        return {"total": 0, "recommendations": [], "priority": priority, "weights": weights,
                "message": "No available menu items match these filters in the current dataset.",
                "model": model_metadata() or {"mode": "fallback", "name": "deterministic preference ranking"},
                "disclaimer": "Synthetic menu subtotals only; taxes, delivery fees, platform fees, and checkout totals are not included."}

    costs = [row["estimatedSubtotal"] for row in candidates]
    etas = [row["etaMin"] for row in candidates if row["etaMin"] is not None]
    min_cost, max_cost = min(costs), max(costs)
    min_eta, max_eta = (min(etas), max(etas)) if etas else (None, None)
    for row in candidates:
        values = {
            "cost": (max_cost - row["estimatedSubtotal"]) / (max_cost - min_cost) if max_cost != min_cost else 1.0,
            "eta": ((max_eta - row["etaMin"]) / (max_eta - min_eta) if max_eta != min_eta else 1.0) if row["etaMin"] is not None and max_eta is not None else 0.5,
            "reliability": row["reliability"] if row["reliability"] is not None else 0.5,
            "rating": min(1.0, max(0.0, (row["rating"] - 1) / 4)) if row["rating"] is not None else 0.5,
        }
        known = {"cost": True, "eta": row["etaMin"] is not None, "reliability": row["reliability"] is not None, "rating": row["rating"] is not None}
        row["factors"] = [{"factor": name, "weight": weights[name], "value": round(values[name], 3), "known": known[name]} for name in weights]
        freshness_penalty = {"fresh": 0.0, "aging": 0.02, "stale": 0.06}[row["freshness"]["status"]]
        row["score"] = round(max(0.0, min(100.0, (sum(weights[name] * values[name] for name in weights) - freshness_penalty) * 100)), 2)
        behavior_count = row["behaviorCuisineCount"]
        behavior_bonus = min(0.05, behavior_count * 0.01) if behavior_count >= 3 else 0.0
        row["score"] = round(min(100.0, row["score"] + behavior_bonus * 100), 2)
        row["reasons"] = [
            f"Listed item price × quantity {people} (one item per person): ₹{row['estimatedSubtotal']:.2f}, before taxes and fees.",
            f"Reported delivery estimate: {row['etaMin']:g} minutes." if row["etaMin"] is not None else "Delivery estimate is unavailable.",
            f"Adjusted provider rating: {row['rating']:.2f}/5 from {row['ratingCount']} ratings." if row["rating"] is not None else "Provider rating is unavailable.",
            f"Delivery feedback: {row['reliability']:.0%} positive across {row['reliabilityMentions']} labeled reviews." if row["reliability"] is not None else "Fewer than 3 labeled delivery reviews; reliability is treated as unknown.",
            f"Freshness penalty applied: {freshness_penalty:.0%}." if freshness_penalty else "No freshness penalty applied.",
            *( [f"Matches your selected cuisine preference: {cuisine_query}."] if cuisine_query else [] ),
            *( [f"Matches your selected city: {city.strip()}."] if city_query else [] ),
            *( [f"Matches your selected area: {requested_area}."] if area_query else [] ),
            *( [f"Small behavior bonus from {behavior_count} consented interactions matching these cuisines."] if behavior_bonus else [] ),
        ]

    model_rows = []
    priority_flags = {
        "priority_cost": float(priority == "cheapest"),
        "priority_speed": float(priority == "fastest"),
        "priority_rating": float(priority == "rated"),
    }
    model_budget = budgetPerPerson if budgetPerPerson is not None else 600.0
    model_eta_limit = float(maxDeliveryTime if maxDeliveryTime is not None else 90)
    for row in candidates:
        model_rows.append({"unit_price": row["unitPrice"], "budget": model_budget,
                           "budget_ratio": row["unitPrice"] / model_budget,
                           "vegetarian_match": float(row["vegetarian"] == bool(vegetarian)) if vegetarian is not None else 0.5,
                           "eta": row["etaMin"], "eta_limit": model_eta_limit,
                           "rating": row["rating"], **priority_flags})
    model_scores = predict_fit(model_rows)
    model_info = model_metadata() if model_scores is not None else None
    if model_scores is not None:
        for row, probability in zip(candidates, model_scores):
            behavior_count = row["behaviorCuisineCount"]
            consented_bonus = min(0.05, behavior_count * 0.01) if behavior_count >= 3 else 0.0
            row["score"] = round(min(1.0, probability + consented_bonus) * 100, 2)
            row["factors"].append({"factor": "synthetic_model_fit", "weight": 1.0, "value": round(probability, 3), "known": True})
            row["reasons"].append("A trained model ranked preference fit from synthetic simulated preference labels; this is not learned user behavior or nutrition evidence.")
            if consented_bonus:
                row["reasons"].append(f"Small ranking adjustment from {behavior_count} consented interactions matching these cuisines.")

    candidates.sort(key=lambda row: (-row["score"], row["estimatedSubtotal"], row["restaurantName"].casefold(), row["itemName"].casefold()))
    recommendations = []
    seen_restaurants = set()
    for row in candidates:
        if row["restaurantId"] in seen_restaurants:
            continue
        seen_restaurants.add(row["restaurantId"])
        row.pop("reliability")
        row.pop("reliabilityMentions")
        row.pop("behaviorCuisineCount")
        recommendations.append(row)
        if len(recommendations) >= limit:
            break
    return {
        "total": len(candidates), "recommendations": recommendations, "priority": priority,
        "weights": weights,
        "filters": {"budgetPerPerson": budgetPerPerson, "people": people, "vegetarian": vegetarian, "cuisine": cuisine, "city": city, "area": requested_area, "maxDeliveryTime": maxDeliveryTime},
        "model": model_info or {"mode": "fallback", "name": "deterministic preference ranking"},
        "disclaimer": "Synthetic CSV menu data. Subtotals use listed item prices only; taxes, delivery/platform fees, discounts, and checkout totals are not included.",
    }


@app.get("/api/intelligence/review-signals")
def get_suspicious_review_signals(limit: int = 50):
    """Return explainable duplicate/burst signals for human inspection only."""
    if not 1 <= limit <= 100:
        raise HTTPException(status_code=400, detail="limit must be between 1 and 100.")
    reviews_path = os.path.join(SCRIPT_DIR, "data", "reviews.csv")
    if not os.path.exists(reviews_path):
        raise HTTPException(status_code=503, detail="Review dataset is unavailable.")
    reviews = pd.read_csv(reviews_path).fillna("")
    if reviews.empty:
        return {"totalReviews": 0, "signalCount": 0, "signals": [], "disclaimer": "No review data is available."}
    reviews["_normalized_text"] = reviews.get("review_text", pd.Series(dtype=str)).astype(str).str.casefold().str.replace(r"\s+", " ", regex=True).str.strip()
    signals = []
    duplicates = reviews[reviews["_normalized_text"].ne("")].groupby("_normalized_text", sort=False, dropna=False)
    for text, group in duplicates:
        if len(group) < 2:
            continue
        dates = pd.to_datetime(group.get("review_date"), errors="coerce")
        signals.append({
            "type": "repeated_text",
            "reviewCount": int(len(group)),
            "reviewIds": group.get("review_id", pd.Series(dtype=str)).astype(str).tolist()[:10],
            "providers": sorted(group.get("provider", pd.Series(dtype=str)).astype(str).unique().tolist()),
            "listingIds": sorted(group.get("listing_id", pd.Series(dtype=str)).astype(str).unique().tolist()),
            "dateRange": {"from": dates.min().date().isoformat() if dates.notna().any() else None, "to": dates.max().date().isoformat() if dates.notna().any() else None},
            "excerpt": str(text)[:180],
            "reason": "Identical normalized review text appears in multiple records; this may reflect synthetic template reuse or syndication.",
        })
    if {"provider", "review_date"} <= set(reviews.columns):
        bursts = reviews.groupby(["provider", "review_date"], dropna=False, sort=False)
        for (provider, review_date), group in bursts:
            if len(group) >= 4:
                signals.append({"type": "same_day_volume_cluster", "reviewCount": int(len(group)),
                                "provider": str(provider), "date": str(review_date),
                                "reviewIds": group.get("review_id", pd.Series(dtype=str)).astype(str).tolist()[:10],
                                "reason": "Four or more reviews share this provider/date in a small synthetic dataset; inspect context before drawing conclusions."})
    signals.sort(key=lambda signal: (-signal["reviewCount"], signal["type"], signal.get("date", "")))
    return {
        "totalReviews": int(len(reviews)), "signalCount": len(signals), "signals": signals[:limit],
        "disclaimer": "These are review-pattern signals for human inspection, not fraud determinations. The review dataset is synthetic and reuses generated text templates.",
    }

@app.post("/api/compare")
def compare_basket(payload: dict = Body(...)):
    restaurant_id = _text(payload.get("restaurantId"))
    selections = payload.get("selections")
    if not restaurant_id or not isinstance(selections, list) or not selections:
        raise HTTPException(status_code=400, detail="restaurantId and at least one basket selection are required.")
    normalized_selections = []
    for selection in selections:
        if not isinstance(selection, dict):
            raise HTTPException(status_code=400, detail="Each basket selection must be an object.")
        item_id = _text(selection.get("itemId"))
        quantity = selection.get("qty", selection.get("quantity", 1))
        if not item_id or isinstance(quantity, bool):
            raise HTTPException(status_code=400, detail="Each selection requires itemId and an integer qty from 1 to 20.")
        try:
            numeric_quantity = float(quantity)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Each selection requires itemId and an integer qty from 1 to 20.")
        if not math.isfinite(numeric_quantity) or not numeric_quantity.is_integer() or not 1 <= numeric_quantity <= 20:
            raise HTTPException(status_code=400, detail="Each selection requires itemId and an integer qty from 1 to 20.")
        normalized_selections.append({"itemId": item_id, "quantity": int(numeric_quantity)})

    max_eta = payload.get("maxEta")
    if max_eta is not None:
        if isinstance(max_eta, bool):
            raise HTTPException(status_code=400, detail="maxEta must be a positive number.")
        try:
            max_eta = float(max_eta)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="maxEta must be a positive number.")
        if not math.isfinite(max_eta) or max_eta <= 0:
            raise HTTPException(status_code=400, detail="maxEta must be a positive number.")

    canonical, providers, menus, offers, reviews = load_all()
    reviews = _deduplicate_review_text(reviews)
    restaurant_listings = providers[providers["canonical_restaurant_id"].astype(str) == restaurant_id]
    if restaurant_listings.empty:
        alias = providers[providers["listing_id"].astype(str) == restaurant_id]
        if not alias.empty:
            linked_id = _text(alias.iloc[0].get("canonical_restaurant_id"))
            restaurant_listings = providers[providers["canonical_restaurant_id"].astype(str) == linked_id] if linked_id else alias
    if restaurant_listings.empty:
        raise HTTPException(status_code=404, detail="Restaurant or provider listings not found.")

    priority_value = payload.get("priority", "value")
    if not isinstance(priority_value, str):
        raise HTTPException(status_code=400, detail="priority must be a string.")
    priority = _text(priority_value, "value").casefold().replace(" ", "_")
    priority_aliases = {"best_value": "value", "most_reliable": "reliable", "best_rated": "rated"}
    priority = priority_aliases.get(priority, priority)
    weights_map = {
        "value": {"cost": 0.40, "eta": 0.20, "reliability": 0.25, "rating": 0.15},
        "cheapest": {"cost": 0.70, "eta": 0.10, "reliability": 0.10, "rating": 0.10},
        "fastest": {"cost": 0.10, "eta": 0.70, "reliability": 0.10, "rating": 0.10},
        "reliable": {"cost": 0.10, "eta": 0.15, "reliability": 0.65, "rating": 0.10},
        "rated": {"cost": 0.10, "eta": 0.10, "reliability": 0.20, "rating": 0.60},
    }
    if priority not in weights_map:
        raise HTTPException(status_code=400, detail="priority must be value, cheapest, fastest, reliable, or rated.")
    weights = weights_map[priority]
    eligible = []
    excluded = []
    for _, listing in restaurant_listings.iterrows():
        listing_id = str(listing["listing_id"])
        provider_name = _text(listing.get("provider"), "Unknown provider")
        provider_id = _provider_id(provider_name)
        eta = _number(listing.get("average_delivery_time_minutes"))
        pricing_result = price_basket(listing_id, normalized_selections, menus, offers, providers)
        if not pricing_result["available"]:
            excluded.append({"providerId": provider_id, "providerName": provider_name, "reason": pricing_result["reason"]})
            continue
        if max_eta is not None and eta is not None and eta > max_eta:
            reason = f"Delivery time ({eta:g} min) exceeds the {max_eta:g} min limit."
            excluded.append({"providerId": provider_id, "providerName": provider_name, "reason": reason})
            continue
        listing_reviews = reviews[reviews["listing_id"].astype(str) == listing_id]
        sentiments = listing_reviews.get("delivery_sentiment", pd.Series(dtype=str)).fillna("").astype(str).str.casefold()
        expressed = sentiments[sentiments.isin(["positive", "neutral", "negative"])]
        reliability = float((expressed == "positive").mean()) if len(expressed) >= 3 else None
        raw_rating = _number(listing.get("rating"))
        rating_count = _number(listing.get("rating_count"), 0) or 0
        adjusted_rating = ((rating_count * raw_rating + 30 * 3.9) / (rating_count + 30)) if raw_rating is not None and rating_count > 0 else None
        pricing = {
            "subtotal": pricing_result["subtotal"],
            "foodTax": pricing_result["food_gst"],
            "deliveryFee": pricing_result["delivery_fee"],
            "platformFee": pricing_result["platform_fee"],
            "feeTax": pricing_result["gst_on_fees"],
            "discount": pricing_result["discount"],
            "discountNote": pricing_result["applied_offer"],
            "total": pricing_result["total"],
            "isLowerBound": pricing_result["is_lower_bound"],
            "unknowns": pricing_result["unknowns"],
            "assumptions": ["Food GST is estimated at 5%."] + (["Delivery and platform fees are unavailable; total excludes them and is a lower bound."] if pricing_result["is_lower_bound"] else []),
            "verified": False,
        }
        freshness = _freshness(listing.get("source_updated_at"))
        eligible.append({
            "providerId": provider_id,
            "providerName": provider_name,
            "url": "",
            "etaMin": eta,
            "freshness": freshness,
            "pricing": pricing,
            "reliability": reliability,
            "rating": round(adjusted_rating, 2) if adjusted_rating is not None else None,
        })

    if not eligible:
        return {"options": [], "excluded": excluded, "weights": weights, "disclaimer": "No provider can fulfil this basket under the selected constraints. Basket totals are synthetic estimates, not provider checkout prices."}

    costs = [option["pricing"]["total"] for option in eligible]
    known_etas = [option["etaMin"] for option in eligible if option["etaMin"] is not None]
    min_cost, max_cost = min(costs), max(costs)
    min_eta, max_eta = (min(known_etas), max(known_etas)) if known_etas else (None, None)
    for option in eligible:
        cost_score = (max_cost - option["pricing"]["total"]) / (max_cost - min_cost) if max_cost != min_cost else 1.0
        eta_known = option["etaMin"] is not None
        eta_score = ((max_eta - option["etaMin"]) / (max_eta - min_eta) if max_eta != min_eta else 1.0) if eta_known and max_eta is not None else 0.5
        reliability_known = option["reliability"] is not None
        reliability_score = option["reliability"] if reliability_known else 0.5
        rating_known = option["rating"] is not None
        rating_score = min(1.0, max(0.0, (option["rating"] - 1.0) / 4.0)) if rating_known else 0.5
        values = {"cost": cost_score, "eta": eta_score, "reliability": reliability_score, "rating": rating_score}
        known = {"cost": True, "eta": eta_known, "reliability": reliability_known, "rating": rating_known}
        factors = [{"factor": factor, "weight": weights[factor], "value": round(values[factor], 3),
                    "contribution": round(weights[factor] * values[factor], 3), "known": known[factor]}
                   for factor in ("cost", "eta", "reliability", "rating")]
        freshness_penalty = {"fresh": 0.0, "aging": 0.02, "stale": 0.06}[option["freshness"]["status"]]
        option["score"] = round(max(0.0, min(100.0, (sum(factor["contribution"] for factor in factors) - freshness_penalty) * 100)), 2)
        option["factors"] = factors
        option["reasons"] = [
            f"Basket estimate: ₹{option['pricing']['total']:.2f}" + (" before unknown delivery/platform fees" if option["pricing"]["isLowerBound"] else ""),
            f"Reported delivery time: {option['etaMin']} min" if eta_known else "Delivery time is unknown.",
            f"Adjusted rating: {option['rating']:.2f}/5" if rating_known else "Rating evidence is unavailable.",
            f"Delivery feedback: {option['reliability']:.0%} positive across at least 3 labeled reviews." if reliability_known else "Fewer than 3 labeled delivery reviews; reliability is treated as unknown.",
            f"Freshness penalty: {freshness_penalty:.0%}." if freshness_penalty else "No freshness penalty applied.",
        ]
        option["badges"] = []
        option.pop("reliability")
        option.pop("rating")

    eligible.sort(key=lambda option: (-option["score"], option["pricing"]["total"], option["providerName"]))
    for rank, option in enumerate(eligible, start=1):
        option["rank"] = rank
        if rank == 1:
            option["badges"].append("Best match for selected priority")
        if option["pricing"]["total"] == min_cost:
            option["badges"].append("Lowest estimated basket total")
        if option["etaMin"] is not None and option["etaMin"] == min_eta:
            option["badges"].append("Fastest reported delivery")

    return {
        "options": eligible,
        "excluded": excluded,
        "weights": weights,
        "disclaimer": "Synthetic demo data. Basket totals use a 5% food GST assumption; unknown fees are excluded and shown as a lower bound. No checkout total is verified.",
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=os.getenv("HOST", "127.0.0.1"), port=8000, reload=True)
