import React, { useState } from "react";
import { api, useData } from "./api";
import { State } from "./ui";

export const addressFields = [
  ["address", "Street address and apartment", "street-address", 250],
  ["city", "City or town", "address-level2", 100],
  ["region", "State or region", "address-level1", 100],
  ["postalCode", "Postal code", "postal-code", 20],
  ["country", "Country", "country-name", 100],
];

function ProfileForm({ profile, onSaved }) {
  const [saved, setSaved] = useState(profile);
  const [email, setEmail] = useState(profile.email);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const emailChanged = email.trim().toLowerCase() !== saved.email;
  async function submit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const { name, email, phone, currentPassword, ...address } =
      Object.fromEntries(new FormData(form));
    setBusy(true);
    setFeedback(null);
    try {
      const { user } = await api("/auth/profile", {
        method: "PATCH",
        body: { name, email, phone, currentPassword, pickup_address: address },
      });
      setSaved(user);
      setEmail(user.email);
      onSaved(user);
      setFeedback({ message: "Account details saved." });
    } catch (error) {
      setFeedback({ error: true, message: error.message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="settings-form" onSubmit={submit}>
      <fieldset disabled={busy}>
        <section className="market-panel settings-section">
          <h2>Contact details</h2>
          <div className="settings-fields">
            <label>
              Full name
              <input
                name="name"
                autoComplete="name"
                maxLength={100}
                defaultValue={saved.name}
                required
              />
            </label>
            <label>
              Phone number
              <input
                name="phone"
                type="tel"
                autoComplete="tel"
                maxLength={28}
                defaultValue={saved.phone || ""}
              />
            </label>
            <label className="wide-field">
              Email address
              <input
                name="email"
                type="email"
                autoComplete="email"
                required
                maxLength={254}
                value={email}
                readOnly={saved.google_only}
                onChange={(event) => setEmail(event.target.value)}
              />
              {saved.google_only && (
                <small>
                  This email is associated with your Google sign-in.
                </small>
              )}
            </label>
            {emailChanged && (
              <label className="wide-field">
                Current password
                <input
                  name="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  required
                />
                <small>Confirm the change to your sign-in email.</small>
              </label>
            )}
          </div>
        </section>
        <section className="market-panel settings-section">
          <h2>Saved address</h2>
          <p>
            These optional details fill in your next checkout. You can edit them
            for each order.
          </p>
          <div className="settings-fields">
            {addressFields.map(([name, label, autoComplete, maxLength]) => (
              <label
                key={name}
                className={name === "address" ? "wide-field" : undefined}
              >
                {label}
                <input
                  name={name}
                  autoComplete={autoComplete}
                  maxLength={maxLength}
                  defaultValue={saved.pickup_address?.[name] || ""}
                />
              </label>
            ))}
          </div>
        </section>
        <div className="settings-actions">
          <button className="primary">
            {busy ? "Saving…" : "Save account details"}
          </button>
          {feedback && (
            <p
              role={feedback.error ? "alert" : "status"}
              className={feedback.error ? "form-error" : "form-success"}
            >
              {feedback.message}
            </p>
          )}
        </div>
      </fieldset>
    </form>
  );
}

export function AccountSettings({ onSaved }) {
  const profile = useData("/auth/profile");
  return (
    <>
      <div className="settings-heading">
        <h1>Account settings</h1>
        <p>Manage your sign-in and checkout details.</p>
      </div>
      <State query={profile}>
        {profile.data && (
          <ProfileForm profile={profile.data.user} onSaved={onSaved} />
        )}
      </State>
    </>
  );
}
