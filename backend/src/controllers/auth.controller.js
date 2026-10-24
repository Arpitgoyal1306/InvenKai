const { registerUser, loginUser } = require("../services/auth.service");

async function register(req, res) {
  try {
    const user = await registerUser(req.body ?? {});

    return res.status(201).json({
      message: "User registered successfully",
      user,
    });
  } catch (error) {
    if (error.statusCode === 400 || error.statusCode === 409) {
      return res.status(error.statusCode).json({
        message: error.message,
      });
    }

    console.error("Registration error:", error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
}

async function login(req, res) {
  try {
    const result = await loginUser(req.body ?? {});

    return res.status(200).json({
      message: "Login successful",
      ...result,
    });
  } catch (error) {
    if (error.statusCode === 400 || error.statusCode === 401) {
      return res.status(error.statusCode).json({
        message: error.message,
      });
    }

    console.error("Login error:", error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
}

module.exports = { register, login };
