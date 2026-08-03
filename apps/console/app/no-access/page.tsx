// Shown to a signed-in user whose account is not an active field supervisor —
// typically a field agent who opened a console link. Their session is left
// intact so the mobile app keeps working; only the console is closed.
export default function NoAccessPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <div className="max-w-md rounded-2xl border border-gray-200 bg-white p-8 text-center">
        <h1 className="text-xl font-bold text-gray-900">
          Walang access sa console.
        </h1>
        <p className="mt-2 text-sm text-gray-600">
          Ang console ay para lang sa field supervisors. Kung ahente ka,
          gamitin ang Datung Field app sa telepono mo — gumagana pa rin ang
          account mo doon.
        </p>
      </div>
    </main>
  );
}
