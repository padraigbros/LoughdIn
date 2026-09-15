package ie.loughdin.app;

import androidx.annotation.NonNull;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.exceptions.NoCredentialException;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;

/**
 * Sign in with Google through Android's Credential Manager, and nothing else.
 * Google does not allow its sign-in page inside the app's WebView, so the
 * system sheet returns an ID token that the web layer hands to Supabase.
 */
@CapacitorPlugin(name = "GoogleSignIn")
public class GoogleSignInPlugin extends Plugin {

    private final Executor executor = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void signIn(PluginCall call) {
        String webClientId = call.getString("webClientId");
        String nonce = call.getString("nonce");
        if (webClientId == null || webClientId.isEmpty() || nonce == null || nonce.isEmpty()) {
            call.reject("webClientId and nonce are required.", "INVALID_ARGUMENT");
            return;
        }

        GetSignInWithGoogleOption option = new GetSignInWithGoogleOption.Builder(webClientId).setNonce(nonce).build();
        GetCredentialRequest request = new GetCredentialRequest.Builder().addCredentialOption(option).build();
        CredentialManager credentialManager = CredentialManager.create(getContext());

        credentialManager.getCredentialAsync(
            getActivity(),
            request,
            null,
            executor,
            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override
                public void onResult(GetCredentialResponse result) {
                    Credential credential = result.getCredential();
                    if (
                        !(credential instanceof CustomCredential) ||
                        !GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())
                    ) {
                        call.reject("Google returned an unexpected credential.", "UNEXPECTED_CREDENTIAL");
                        return;
                    }
                    try {
                        GoogleIdTokenCredential google = GoogleIdTokenCredential.createFrom(((CustomCredential) credential).getData());
                        JSObject response = new JSObject();
                        response.put("idToken", google.getIdToken());
                        call.resolve(response);
                    } catch (Exception e) {
                        call.reject("Google's sign-in response could not be read.", "INVALID_TOKEN", e);
                    }
                }

                @Override
                public void onError(@NonNull GetCredentialException e) {
                    if (e instanceof GetCredentialCancellationException) {
                        call.reject("Google sign-in was cancelled.", "CANCELLED");
                    } else if (e instanceof NoCredentialException) {
                        call.reject("No Google account is available on this device.", "NO_ACCOUNT");
                    } else {
                        call.reject("Google sign-in failed. Try again.", "FAILED", e);
                    }
                }
            }
        );
    }
}
