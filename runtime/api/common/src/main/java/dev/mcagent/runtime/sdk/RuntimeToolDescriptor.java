package dev.mcagent.runtime.sdk;

import java.util.Map;
import java.util.Objects;

/** Public SDK description of one currently callable Runtime Tool. */
public record RuntimeToolDescriptor(String name, String description, Map<String, Object> parameters, String execution) {
    public RuntimeToolDescriptor(String name, String description, Map<String, Object> parameters) {
        this(name, description, parameters, "query");
    }

    public RuntimeToolDescriptor {
        Objects.requireNonNull(name, "name");
        if (!"body".equals(execution) && !"query".equals(execution)) {
            throw new IllegalArgumentException("execution must be body or query");
        }
        Objects.requireNonNull(description, "description");
        parameters = Map.copyOf(Objects.requireNonNull(parameters, "parameters"));
    }
}
