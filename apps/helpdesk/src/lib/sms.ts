
const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM = process.env.TWILIO_FROM;

export const smsEnabled = Boolean(SID && TOKEN && FROM);

export async function sendSms(to: string, body: string) {
  if (!smsEnabled || !to) return;
  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: to, From: FROM!, Body: body }),
      }
    );
    if (!response.ok) {
      console.error("SMS send failed:", response.status, await response.text());
    }
  } catch (error) {
    console.error("SMS send failed:", error);
  }
}
