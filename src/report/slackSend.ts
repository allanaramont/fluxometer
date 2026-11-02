export async function postToSlack(
  webhookUrl: string,
  text: string,
): Promise<void> {
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}
