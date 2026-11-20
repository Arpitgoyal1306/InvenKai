import React from "react";
import { ArrowRight, ArrowUpRight, ShoppingBag, Store } from "lucide-react";
import { Link } from "react-router-dom";
import { Brand } from "./ui";

export function Landing({ user }) {
  return (
    <div className="editorial-landing">
      <header className="editorial-header">
        <div className="editorial-header-inner">
          <Link to="/" aria-label="InvenKai home">
            <Brand compact />
          </Link>
          <nav aria-label="Main navigation">
            <Link className="editorial-browse-link" to="/explore">
              Explore stores
            </Link>
            <Link
              className="editorial-account-link"
              to={user ? "/account" : "/login"}
            >
              {user ? "My account" : "Sign in"}{" "}
              <ArrowUpRight size={16} aria-hidden="true" />
            </Link>
          </nav>
        </div>
      </header>
      <main className="editorial-main">
        <section className="editorial-hero" aria-labelledby="editorial-heading">
          <div className="editorial-copy">
            <h1 id="editorial-heading">
              Good things
              <br /> are <em>in store.</em>
            </h1>
            <p>
              Shop independent stores, order your favourites online, and pick
              them up in person.
            </p>
            <div className="editorial-hero-actions">
              <Link className="editorial-button" to="/explore">
                Shop as a buyer <ArrowRight size={18} aria-hidden="true" />
              </Link>
              <Link className="editorial-seller-link" to="/owner">
                Manage my store <ArrowUpRight size={16} aria-hidden="true" />
              </Link>
            </div>
          </div>
          <img
            className="editorial-hero-photo"
            src="/images/marketplace-storefront.webp"
            alt="An independent grocer with a green shopfront and baskets of produce"
            width="1440"
            height="960"
            fetchPriority="high"
          />
        </section>
        <div className="editorial-paths">
          <Link to="/buyer/orders">
            <span className="editorial-path-icon">
              <ShoppingBag size={23} aria-hidden="true" />
            </span>
            <span>
              <strong>Track a pickup</strong>
              <small>Check order status and download receipts.</small>
            </span>
            <ArrowUpRight
              className="editorial-path-arrow"
              size={20}
              aria-hidden="true"
            />
          </Link>
          <Link to="/owner/low-stock">
            <span className="editorial-path-icon">
              <Store size={23} aria-hidden="true" />
            </span>
            <span>
              <strong>Check low stock</strong>
              <small>See which products are due for a restock.</small>
            </span>
            <ArrowUpRight
              className="editorial-path-arrow"
              size={20}
              aria-hidden="true"
            />
          </Link>
        </div>
      </main>
    </div>
  );
}
