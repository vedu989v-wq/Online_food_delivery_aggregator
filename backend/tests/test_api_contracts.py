import os
import sys
from pathlib import Path

import pandas as pd
import pytest
from fastapi.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

import main  # noqa: E402
from services.admin_service import reset_demo_decisions  # noqa: E402


@pytest.fixture(autouse=True)
def clean_demo_decisions():
    reset_demo_decisions()
    yield
    reset_demo_decisions()


@pytest.fixture
def client():
    return TestClient(main.app, client=("127.0.0.1", 54321))


def test_meta_returns_frontend_contract(client):
    response = client.get("/api/meta")
    assert response.status_code == 200
    body = response.json()
    assert body["dataMode"] == "synthetic"
    assert "not live or verified" in body["notice"]
    assert {"id", "name"} <= body["providers"][0].keys()
    assert body["adminDemoEnabled"] is False
    assert "South Indian" in body["cuisines"]


def test_sentiment_scores_shrink_sparse_feedback_toward_neutral():
    one = main._sentiment_aggregate(pd.DataFrame({"food_sentiment": ["positive"]}), "food_sentiment")
    three = main._sentiment_aggregate(pd.DataFrame({"food_sentiment": ["positive", "positive", "positive"]}), "food_sentiment")
    assert one["score"] == 0.667
    assert one["enough"] is False
    assert three["score"] == 0.8
    assert three["enough"] is True


def test_review_text_deduplication_normalizes_whitespace_and_keeps_blank_rows():
    reviews = pd.DataFrame({"review_id": ["A", "B", "C", "D"], "review_text": ["Good food", " good  food ", "", None]})
    unique = main._deduplicate_review_text(reviews)
    assert unique["review_id"].tolist() == ["A", "C", "D"]


def test_search_returns_grouped_restaurant_cards_from_csv(client):
    response = client.get("/api/search", params={"q": "Uttapam", "cuisine": "South Indian"})
    assert response.status_code == 200
    body = response.json()
    assert body["total"] > 0
    result = body["results"][0]
    assert {"id", "name", "area", "cuisines", "rating", "matchedItems", "providers"} <= result.keys()
    assert any("Uttapam" in item["name"] for item in result["matchedItems"])
    assert all({"id", "name", "etaMin", "freshness"} <= provider.keys() for provider in result["providers"])


def test_search_paginates_and_validates_filters(client):
    first = client.get("/api/search", params={"page": 1, "pageSize": 10}).json()
    second = client.get("/api/search", params={"page": 2, "pageSize": 10}).json()
    assert first["total"] > 10
    assert first["pageSize"] == 10
    assert first["results"][0]["id"] != second["results"][0]["id"]
    assert client.get("/api/search", params={"pageSize": 51}).status_code == 400


def test_search_supports_city_and_area_filters(client):
    all_results = client.get("/api/search", params={"pageSize": 50}).json()
    assert all_results["total"] > 0
    sample_city = "Bengaluru"
    city_results = client.get("/api/search", params={"city": sample_city, "pageSize": 50}).json()
    assert city_results["total"] > 0
    first_area = city_results["results"][0]["area"]
    area_results = client.get("/api/search", params={"city": sample_city, "area": first_area, "pageSize": 50}).json()
    assert area_results["total"] > 0
    assert area_results["total"] <= city_results["total"]


def test_data_endpoints_return_service_unavailable_when_required_csv_is_missing(client, monkeypatch):
    missing_root = BACKEND_DIR / "missing_data_test_root"
    monkeypatch.setattr(main, "SCRIPT_DIR", str(missing_root))
    response = client.get("/api/restaurants/CAN0001")
    assert response.status_code == 503


def test_restaurant_detail_returns_complete_frontend_shape_from_csv(client):
    response = client.get("/api/restaurants/CAN0001")
    assert response.status_code == 200
    body = response.json()
    assert {"id", "name", "area", "phone", "cuisines", "listings", "items", "reputation", "conflicts", "observations"} <= body.keys()
    assert body["id"] == "CAN0001"
    assert body["listings"] and body["items"]
    assert {"providerId", "providerName", "recordId", "etaMin", "fetchedAt", "freshness"} <= body["listings"][0].keys()
    assert {"id", "name", "veg", "portion", "offers"} <= body["items"][0].keys()
    assert {"evidence", "reviewsAnalyzed", "rating", "aspects", "providerDelivery", "highlights"} <= body["reputation"].keys()


def test_single_provider_detail_and_compare_use_listing_id_fallback(client):
    listings = pd.read_csv(BACKEND_DIR / "data" / "provider_restaurants.csv")
    menus = pd.read_csv(BACKEND_DIR / "data" / "provider_menu_items.csv")
    singles = listings[listings["canonical_restaurant_id"].isna()]
    available_menus = menus[
        menus["listing_id"].astype(str).isin(singles["listing_id"].astype(str))
        & menus["is_available"].astype(str).str.casefold().isin(["true", "1"])
        & menus["price_inr"].notna()
    ]
    assert not available_menus.empty
    selected_menu = available_menus.iloc[0]
    single = singles[singles["listing_id"].astype(str) == str(selected_menu["listing_id"])].iloc[0]
    detail_response = client.get(f"/api/restaurants/{single['listing_id']}")
    assert detail_response.status_code == 200
    detail = detail_response.json()
    assert detail["id"] == single["listing_id"]
    assert len(detail["listings"]) == 1

    item = next(item for item in detail["items"] if item["id"] == selected_menu["normalized_item_name"])
    available = next(offer for offer in item["offers"] if offer["available"] and offer["price"] is not None)
    response = client.post("/api/compare", json={
        "restaurantId": detail["id"],
        "selections": [{"itemId": item["id"], "qty": 2}],
        "priority": "value",
    })
    assert response.status_code == 200
    assert any(option["pricing"]["subtotal"] == pytest.approx(2 * available["price"]) for option in response.json()["options"])


def test_compare_accepts_frontend_qty_and_returns_compare_contract(client):
    providers = pd.read_csv(BACKEND_DIR / "data" / "provider_restaurants.csv")
    menus = pd.read_csv(BACKEND_DIR / "data" / "provider_menu_items.csv")
    available = menus[menus["is_available"].astype(str).str.casefold().isin(["true", "1"])]
    selection = None
    restaurant_id = None
    for _, menu in available.iterrows():
        provider = providers[providers["listing_id"].astype(str) == str(menu["listing_id"])].iloc[0]
        linked_id = provider.get("canonical_restaurant_id")
        restaurant_id = str(linked_id) if pd.notna(linked_id) else str(provider["listing_id"])
        selection = {"itemId": str(menu["normalized_item_name"]), "qty": 3}
        break
    assert selection is not None

    response = client.post("/api/compare", json={"restaurantId": restaurant_id, "selections": [selection], "priority": "cheapest"})
    assert response.status_code == 200
    body = response.json()
    assert {"options", "excluded", "disclaimer"} <= body.keys()
    assert body["options"]
    option = body["options"][0]
    assert {"rank", "providerId", "providerName", "pricing", "score", "badges", "reasons", "factors"} <= option.keys()
    assert option["pricing"]["subtotal"] > 0
    assert option["pricing"]["verified"] is False
    assert len(option["factors"]) == 4


def test_compare_rejects_invalid_quantity(client):
    response = client.post("/api/compare", json={"restaurantId": "CAN0001", "selections": [{"itemId": "masala-dosa", "qty": 0}]})
    assert response.status_code == 400


def test_recommendations_are_ranked_from_available_csv_menu_rows(client):
    response = client.get("/api/intelligence/recommendations", params={
        "budgetPerPerson": 500, "people": 2, "vegetarian": "true", "cuisine": "South Indian", "priority": "cheapest", "limit": 8,
    })
    assert response.status_code == 200
    body = response.json()
    assert body["recommendations"]
    assert body["priority"] == "cheapest"
    assert body["weights"]["cost"] > body["weights"]["eta"]
    first = body["recommendations"][0]
    assert {"restaurantId", "itemId", "providerName", "estimatedSubtotal", "score", "reasons", "factors"} <= first.keys()
    assert first["vegetarian"] is True
    assert any("South Indian" in cuisine for cuisine in first["cuisines"])
    canonical = pd.read_csv(BACKEND_DIR / "data" / "canonical_restaurants.csv").set_index("canonical_restaurant_id")
    if first["restaurantId"] in canonical.index:
        assert first["restaurantName"] == canonical.loc[first["restaurantId"], "canonical_name"]
    assert first["estimatedSubtotal"] <= 1000
    assert first["reasons"]
    assert len(first["factors"]) >= 4
    assert body["model"]["mode"] in ("trained", "fallback")
    assert "taxes" in body["disclaimer"]


def test_recommendations_reject_unknown_priority(client):
    response = client.get("/api/intelligence/recommendations", params={"priority": "random"})
    assert response.status_code == 400


def test_recommendations_apply_delivery_time_limit(client):
    response = client.get("/api/intelligence/recommendations", params={"maxDeliveryTime": 30, "limit": 50})
    assert response.status_code == 200
    body = response.json()
    assert body["filters"]["maxDeliveryTime"] == 30
    assert all(row["etaMin"] is not None and row["etaMin"] <= 30 for row in body["recommendations"])
    assert client.get("/api/intelligence/recommendations", params={"maxDeliveryTime": 241}).status_code == 400


def test_recommendations_reject_malformed_behavior_signals(client):
    for value in ("{}", '[{"cuisine":"South Indian","count":"bad"}]'):
        response = client.get("/api/intelligence/recommendations", params={"behaviorSignals": value})
        assert response.status_code == 400


def test_recommendations_use_supported_city_location(client):
    response = client.get("/api/intelligence/recommendations", params={"city": "Bengaluru", "limit": 50})
    assert response.status_code == 200
    body = response.json()
    assert body["filters"]["city"] == "Bengaluru"
    assert all(any("Bengaluru" in reason for reason in row["reasons"]) for row in body["recommendations"])


def test_compare_rejects_unknown_priority(client):
    response = client.post("/api/compare", json={"restaurantId": "CAN0001", "selections": [{"itemId": "masala-dosa", "qty": 1}], "priority": "random"})
    assert response.status_code == 400


def test_unknown_delivery_estimate_does_not_fail_eta_limit(client):
    providers = pd.read_csv(BACKEND_DIR / "data" / "provider_restaurants.csv")
    menus = pd.read_csv(BACKEND_DIR / "data" / "provider_menu_items.csv")
    available = menus[menus["is_available"].astype(str).str.casefold().isin(["true", "1"]) & menus["price_inr"].notna()]
    candidates = providers[providers["average_delivery_time_minutes"].isna()]
    match = None
    for _, listing in candidates.iterrows():
        rows = available[available["listing_id"].astype(str) == str(listing["listing_id"])]
        if not rows.empty:
            match = (listing, rows.iloc[0])
            break
    assert match is not None
    listing, menu = match
    restaurant_id = str(listing["canonical_restaurant_id"]) if pd.notna(listing["canonical_restaurant_id"]) else str(listing["listing_id"])
    response = client.post("/api/compare", json={"restaurantId": restaurant_id, "selections": [{"itemId": str(menu["normalized_item_name"]), "qty": 1}], "maxEta": 1})
    assert response.status_code == 200
    provider_id = str(listing["provider"]).casefold().replace(" ", "-")
    option = next(row for row in response.json()["options"] if row["providerId"] == provider_id)
    assert option["etaMin"] is None


def test_unknown_availability_is_not_treated_as_available(client):
    menus = pd.read_csv(BACKEND_DIR / "data" / "provider_menu_items.csv")
    providers = pd.read_csv(BACKEND_DIR / "data" / "provider_restaurants.csv")
    unknown = menus[menus["is_available"].isna()].iloc[0]
    listing = providers[providers["listing_id"].astype(str) == str(unknown["listing_id"])].iloc[0]
    restaurant_id = str(listing["canonical_restaurant_id"]) if pd.notna(listing["canonical_restaurant_id"]) else str(listing["listing_id"])
    detail = client.get(f"/api/restaurants/{restaurant_id}").json()
    item = next(row for row in detail["items"] if row["id"] == str(unknown["normalized_item_name"]))
    provider_id = str(listing["provider"]).casefold().replace(" ", "-")
    offer = next(row for row in item["offers"] if row["providerId"] == provider_id)
    assert offer["available"] is False
    assert offer["price"] is None or offer["price"] > 0


def test_review_signals_are_labeled_for_human_review(client):
    response = client.get("/api/intelligence/review-signals")
    assert response.status_code == 200
    body = response.json()
    assert body["totalReviews"] == len(pd.read_csv(BACKEND_DIR / "data" / "reviews.csv"))
    assert body["signalCount"] > 0
    assert any(signal["type"] == "repeated_text" for signal in body["signals"])
    assert "not fraud" in body["disclaimer"].lower()


def test_admin_read_contract_and_demo_decision_is_ephemeral(client, monkeypatch):
    monkeypatch.setenv("ADMIN_DEMO_MODE", "true")
    monkeypatch.delenv("NODE_ENV", raising=False)
    queue_response = client.get("/api/admin/review-queue")
    assert queue_response.status_code == 200
    queue = queue_response.json()
    assert queue["demoOnly"] is True
    assert queue["mutationsEnabled"] is True
    assert queue["pending"]
    candidate = queue["pending"][0]
    assert {"id", "similarityCase", "rationale", "a", "b"} <= candidate.keys()

    pipeline = client.get("/api/admin/pipeline").json()
    assert {"rawListings", "canonicalRestaurants", "pendingReviews", "issues"} <= pipeline.keys()
    assert {"menuItems", "offers", "reviews", "issueCount"} <= pipeline.keys()
    assert pipeline["rawListings"] == len(pd.read_csv(BACKEND_DIR / "data" / "provider_restaurants.csv"))
    assert pipeline["menuItems"] == len(pd.read_csv(BACKEND_DIR / "data" / "provider_menu_items.csv"))

    decision = client.post(f"/api/admin/review-queue/{candidate['id']}/decision", json={"decision": "keep_separate"})
    assert decision.status_code == 200
    assert decision.json()["persisted"] is False
    assert all(item["id"] != candidate["id"] for item in client.get("/api/admin/review-queue").json()["pending"])


def test_admin_mutation_disabled_without_explicit_demo_flag(client, monkeypatch):
    monkeypatch.delenv("ADMIN_DEMO_MODE", raising=False)
    queue = client.get("/api/admin/review-queue").json()
    candidate_id = queue["pending"][0]["id"]
    response = client.post(f"/api/admin/review-queue/{candidate_id}/decision", json={"decision": "merge"})
    assert response.status_code == 403


def test_admin_mutation_rejects_non_loopback_client(monkeypatch):
    monkeypatch.setenv("ADMIN_DEMO_MODE", "true")
    monkeypatch.delenv("NODE_ENV", raising=False)
    remote_client = TestClient(main.app, client=("192.0.2.10", 54321))
    candidate_id = remote_client.get("/api/admin/review-queue").json()["pending"][0]["id"]
    response = remote_client.post(f"/api/admin/review-queue/{candidate_id}/decision", json={"decision": "merge"})
    assert response.status_code == 403
