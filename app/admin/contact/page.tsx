import { listContactMessagesForAdmin } from "@/lib/contact";
import { ContactMessageList } from "@/app/admin/contact/contact-message-list";

export default async function AdminContactPage() {
  const messages = await listContactMessagesForAdmin();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-xl font-semibold">Contact</h1>
        <p className="text-sm text-muted-foreground">
          Messages submitted through the public contact form, newest first — including whether
          the notification email actually delivered.
        </p>
      </div>
      <ContactMessageList messages={messages} />
    </div>
  );
}
